// Moving a library's files to another store (PV7, PV-47): managed R2 to a customer bucket, back, or between buckets.
// Runs as MigrateStorageWorkflow, one page of blobs per step, so a lost run resumes where it stopped.
//
// While it runs, the library's index holds its storage lock: uploads, purges and the pipeline's blob swaps are
// refused, and reads keep coming from the old store, which still has everything. Each object is copied and its
// SHA-256 checked against the index before the page counts as done. At the end the index switches to the new store,
// the old customer backend (if any) is retired, and serving is told. Old copies are left where they were: a team's
// files are only ever deleted through trash and retention, and the old bucket is the team's to clean up.

import { createSqlExecutor } from "@saas/db/d1";
import { createMediaRepository } from "@saas/db/media";
import { remoteStore, type MediaStore } from "@saas/shared/media-store";
import type { Env } from "../env.js";
import { indexFor } from "../index-do/client.js";
import type { Step, StepConfig } from "../pipeline/run.js";
import { publishLibraryMap } from "../serving.js";
import { streamingDigest } from "./object-store.js";
import { forgetStore } from "./stores.js";

export interface MigrationParams {
  migrationId: string;
  orgId: string;
  libraryId: string;
  /** "managed" or the source customer backend's id. */
  from: string;
  /** "managed" or the target customer backend's id (created pending). */
  to: string;
}

export const MIGRATION_PAGE = 50;
/** Objects above this are copied in parts (a Worker can't hold a 2 GB file). */
export const COPY_PART_BYTES = 32 * 1024 * 1024;
/** The lock is renewed with each page; a run that dies leaves the library locked for at most this long. */
export const LOCK_RENEW_MS = 30 * 60_000;

const RETRY: StepConfig = { retries: { limit: 5, delay: "15 seconds", backoff: "exponential" }, timeout: "10 minutes" };

async function storeForKey(env: Env, orgId: string, libraryId: string, key: string): Promise<MediaStore> {
  if (key === "managed") {
    if (!env.MEDIA_BUCKET) throw new Error("managed_unavailable");
    return env.MEDIA_BUCKET;
  }
  if (!env.PLATFORM_DB || !env.STORAGE_WORKER) throw new Error("storage_unavailable");
  const r = await createMediaRepository(createSqlExecutor(env.PLATFORM_DB)).getStorageBackendById(orgId, libraryId, key);
  if (!r.ok) throw new Error("backend_missing");
  return remoteStore(env.STORAGE_WORKER, { orgId, libraryId, backendId: key, prefix: r.value.prefix });
}

async function sha256Hex(body: ReadableStream | ArrayBuffer): Promise<string> {
  let bytes: Uint8Array;
  const Digest = streamingDigest();
  if (Digest && body instanceof ReadableStream) {
    const d = new Digest("SHA-256");
    await body.pipeTo(d);
    bytes = new Uint8Array(await d.digest);
  } else {
    const buf = body instanceof ReadableStream ? await new Response(body).arrayBuffer() : body;
    bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", buf));
  }
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Copy one object and prove the target holds the right bytes. */
export async function copyObject(src: MediaStore, dst: MediaStore, blob: { object_key: string; size: number; sha256: string }): Promise<"copied" | "missing"> {
  if (blob.size <= COPY_PART_BYTES) {
    const obj = await src.get(blob.object_key);
    if (!obj) return "missing";
    const bytes = await obj.arrayBuffer();
    await dst.put(blob.object_key, bytes, { sha256: blob.sha256 });
  } else {
    const up = await dst.createMultipartUpload(blob.object_key);
    const handle = dst.resumeMultipartUpload(blob.object_key, up.uploadId);
    try {
      const parts = [];
      for (let offset = 0, n = 1; offset < blob.size; offset += COPY_PART_BYTES, n++) {
        const length = Math.min(COPY_PART_BYTES, blob.size - offset);
        const obj = await src.get(blob.object_key, { range: { offset, length } });
        if (!obj) {
          await handle.abort();
          return "missing";
        }
        parts.push(await handle.uploadPart(n, await obj.arrayBuffer()));
      }
      await handle.complete(parts);
    } catch (e) {
      await handle.abort().catch(() => undefined);
      throw e;
    }
  }
  const back = await dst.get(blob.object_key);
  if (!back || (await sha256Hex(back.body)) !== blob.sha256) throw new Error("copy_mismatch");
  return "copied";
}

function codeOf(e: unknown): string {
  const c = (e as { code?: string })?.code;
  if (typeof c === "string" && /^[A-Za-z_]{2,40}$/.test(c)) return c;
  const m = String((e as Error)?.message ?? "").match(/^[a-z_]{2,40}$/);
  return m ? m[0] : "copy_failed";
}

export async function runMigration(env: Env, p: MigrationParams, step: Step, now: () => Date = () => new Date()): Promise<string> {
  const idx = indexFor(env, { orgId: p.orgId, libraryId: p.libraryId, actor: "migration" });
  const repo = env.PLATFORM_DB ? createMediaRepository(createSqlExecutor(env.PLATFORM_DB)) : null;
  const status = (extra: Record<string, unknown>) => idx.call({ op: "setMigration", migration: { id: p.migrationId, from: p.from, to: p.to, ...extra } });
  let after = "";
  let copied = 0;
  let missing = 0;
  try {
    for (let page = 0; ; page++) {
      const r = await step.do(`copy-${page}`, RETRY, async () => {
        await idx.call({ op: "extendStorageLock", untilIso: new Date(now().getTime() + LOCK_RENEW_MS).toISOString() });
        const blobs = await idx.call<{ object_key: string; size: number; sha256: string }[]>({ op: "blobsPage", after, limit: MIGRATION_PAGE });
        if (!blobs.length) return { last: after, copied: 0, missing: 0, done: true };
        const [src, dst] = await Promise.all([storeForKey(env, p.orgId, p.libraryId, p.from), storeForKey(env, p.orgId, p.libraryId, p.to)]);
        let c = 0;
        let m = 0;
        for (const b of blobs) (await copyObject(src, dst, b)) === "copied" ? c++ : m++;
        return { last: blobs[blobs.length - 1]!.object_key, copied: c, missing: m, done: false };
      });
      if (r.done) break;
      after = r.last;
      copied += r.copied;
      missing += r.missing;
      await step.do(`progress-${page}`, RETRY, () => status({ state: "copying", copied, missing, at: now().toISOString() }));
    }
    await step.do("switch", RETRY, async () => {
      const at = now();
      if (repo) {
        if (p.to !== "managed") await repo.activateStorageBackend(p.orgId, p.libraryId, p.to, at);
        if (p.from !== "managed") await repo.retireStorageBackend(p.orgId, p.libraryId, p.from, at);
      }
      await idx.call({ op: "endStorageSwitch", backend: p.to });
      await status({ state: "done", copied, missing, at: at.toISOString() });
      forgetStore(p.orgId, p.libraryId);
      if (repo) {
        const lib = await repo.getLibrary(p.orgId, p.libraryId);
        const suspension = await repo.getOrgSuspension(p.orgId);
        if (lib.ok) await publishLibraryMap(env, lib.value, suspension.ok && suspension.value !== null);
      }
      return true;
    });
    return "done";
  } catch (e) {
    const code = codeOf(e);
    await step.do("fail", RETRY, async () => {
      const at = now();
      if (repo && p.to !== "managed") await repo.failStorageBackend(p.orgId, p.libraryId, p.to, code, at);
      await idx.call({ op: "endStorageSwitch", backend: null });
      await status({ state: "failed", copied, missing, error: code, at: at.toISOString() });
      return true;
    });
    return "failed";
  }
}
