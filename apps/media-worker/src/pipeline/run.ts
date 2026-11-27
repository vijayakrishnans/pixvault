// ProcessFileWorkflow's steps (design §4.3), written against a minimal `step` so tests run exactly this code.
//
// Workflows replace the queue in the design: each step is retried on its own, a run that still fails holds the
// file (never serves it unchecked) and records a row in media_pipeline_failures, the list a replay works from.
// Every step is safe to repeat: the stripped copy is written under a key derived from its own SHA-256, and the swap
// is a no-op once done.

import { createSqlExecutor } from "@saas/db/d1";
import { createMediaRepository, managedPrefix } from "@saas/db/media";
import type { Env } from "../env.js";
import type { FileRow } from "../index-do/core.js";
import { indexFor } from "../index-do/client.js";
import { stripLocation, sniff } from "./metadata.js";
import type { PipelineParams } from "./start.js";

export interface StepConfig {
  retries?: { limit: number; delay: string | number; backoff?: "constant" | "linear" | "exponential" };
  timeout?: string | number;
}

export interface Step {
  do<T>(name: string, config: StepConfig, fn: () => Promise<T>): Promise<T>;
}

const RETRY: StepConfig = { retries: { limit: 3, delay: "10 seconds", backoff: "exponential" }, timeout: "5 minutes" };

/** Images up to this size are read into memory to remove location data; larger ones are held for review. */
export const MAX_SANITIZE_BYTES = 64 * 1024 * 1024;

const SANITIZABLE = /^image\//i;

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", bytes as Uint8Array<ArrayBuffer>);
  return Array.from(new Uint8Array(d), (b) => b.toString(16).padStart(2, "0")).join("");
}

interface Cleaned {
  sha256: string;
  size: number;
  key: string | null;
  removed: string[];
  kind: string;
  /** Set when the file can't be checked and must wait for a person. */
  hold?: string;
}

export async function runPipeline(env: Env, p: PipelineParams, step: Step, now: () => Date = () => new Date()): Promise<string> {
  const idx = indexFor(env, { orgId: p.orgId, libraryId: p.libraryId });
  const bucket = env.MEDIA_BUCKET!;
  const repo = env.PLATFORM_DB ? createMediaRepository(createSqlExecutor(env.PLATFORM_DB)) : null;
  let stage = "load";
  let currentSha = p.sha256;
  try {
    const target = await step.do("load", RETRY, () =>
      idx.call<{ file: FileRow; objectKey: string } | null>({ op: "processingTarget", id: p.fileId, sha256: p.sha256 }),
    );
    if (!target) return "stale"; // replaced, trashed or already processed

    stage = "strip";
    const cleaned = await step.do<Cleaned>("strip", RETRY, async () => {
      const f = target.file;
      if (!SANITIZABLE.test(f.mime)) return { sha256: p.sha256, size: f.size, key: null, removed: [], kind: "other" };
      if (f.size > MAX_SANITIZE_BYTES) {
        return { sha256: p.sha256, size: f.size, key: null, removed: [], kind: "image", hold: "too_large_to_check_location" };
      }
      const obj = await bucket.get(target.objectKey);
      if (!obj || !("arrayBuffer" in obj)) throw new Error("object_missing");
      const bytes = new Uint8Array(await obj.arrayBuffer());
      const kind = sniff(bytes);
      const r = stripLocation(bytes);
      if (!r.changed) return { sha256: p.sha256, size: f.size, key: null, removed: [], kind };
      const sha = await sha256Hex(r.bytes);
      const key = `${managedPrefix(p.orgId, p.libraryId)}blob/s-${sha}`;
      await bucket.put(key, r.bytes, { sha256: sha, httpMetadata: { contentType: f.mime } });
      return { sha256: sha, size: r.bytes.length, key, removed: r.removed, kind };
    });

    if (cleaned.key) {
      stage = "swap";
      await step.do("swap", RETRY, async () => {
        const s = await idx.call<{ deleteKeys: string[]; storedBytes: number; releasedBytes: number }>({
          op: "swapBlob",
          input: { id: p.fileId, fromSha: p.sha256, toSha: cleaned.sha256, toKey: cleaned.key!, toSize: cleaned.size, nowIso: now().toISOString() },
        });
        for (const k of s.deleteKeys) await bucket.delete(k);
        if (repo && s.storedBytes > 0) await repo.addStorage(p.orgId, s.storedBytes, now());
        if (repo && s.releasedBytes > 0) await repo.releaseStorage(p.orgId, s.releasedBytes, now());
        return true;
      });
      currentSha = cleaned.sha256;
    }

    stage = "info";
    const info = cleaned.kind === "other" || cleaned.hold
      ? { width: null, height: null }
      : await step.do("info", RETRY, async () => {
          if (!env.IMAGES) return { width: null, height: null };
          const key = cleaned.key ?? target.objectKey;
          const obj = await bucket.get(key);
          if (!obj || !("body" in obj)) throw new Error("object_missing");
          try {
            const i = (await env.IMAGES.info(obj.body)) as { width?: number; height?: number };
            return { width: typeof i.width === "number" ? i.width : null, height: typeof i.height === "number" ? i.height : null };
          } catch {
            return { width: null, height: null }; // a format the Images binding can't read: no dimensions
          }
        });

    stage = "finish";
    const note = cleaned.hold ?? (cleaned.removed.length ? `removed:${cleaned.removed.join(",")}` : null);
    const status = cleaned.hold ? "held" : target.file.visibility;
    await step.do("finish", RETRY, () =>
      idx.call({
        op: "finishProcessing",
        id: p.fileId,
        sha256: currentSha,
        result: { status, width: info.width, height: info.height, moderation: "skipped", note },
        nowIso: now().toISOString(),
      }),
    );
    return status;
  } catch (e) {
    // Out of retries: hold the file and record the failure for a replay. Never serve it unchecked.
    // Our own failures carry short codes ("object_missing"); anything else is recorded by its class name only, since
    // upstream messages can carry URLs or keys.
    const msg = String((e as Error)?.message ?? "");
    const errorName = /^[a-z][a-z_]{2,39}$/.test(msg) ? msg : ((e as Error)?.name ?? "Error").slice(0, 60);
    await step.do("fail", RETRY, async () => {
      const f = await idx.call<FileRow | null>({ op: "getFile", id: p.fileId });
      if (f && f.status === "processing") {
        await idx.call({
          op: "finishProcessing",
          id: p.fileId,
          sha256: f.blob_sha256,
          result: { status: "held", note: `failed:${stage}` },
          nowIso: now().toISOString(),
        });
      }
      if (repo) {
        await repo.recordPipelineFailure({ orgId: p.orgId, libraryId: p.libraryId, fileId: p.fileId, sha256: currentSha, step: stage, errorName, at: now() });
      }
      return true;
    });
    return "failed";
  }
}
