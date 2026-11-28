// Which store holds a library's files (PV7): its newest backend that isn't retired. Managed R2 is the Worker's own
// binding; a customer bucket goes through storage-worker (@saas/shared/media-store). Decisions are cached per isolate
// for STORE_TTL_MS; a library may only switch storage while it holds no files (PV-46), and anything that starts an
// upload asks with { fresh: true }, so a stale answer never sends new bytes to the old place.

import { createSqlExecutor } from "@saas/db/d1";
import { createMediaRepository } from "@saas/db/media";
import { remoteStore, type MediaStore, type RemoteScope } from "@saas/shared/media-store";
import type { Env } from "../env.js";

export const STORE_TTL_MS = 30_000;

export class StoreUnavailable extends Error {
  constructor() {
    super("store_unavailable");
    this.name = "StoreUnavailable";
  }
}

type Choice = { kind: "managed" } | { kind: "remote"; scope: RemoteScope };
const cache = new Map<string, { at: number; choice: Choice }>();

/** For tests, and after this isolate changes a library's storage. */
export function forgetStore(orgId?: string, libraryId?: string): void {
  if (orgId && libraryId) cache.delete(`${orgId}:${libraryId}`);
  else cache.clear();
}

export async function storeChoice(env: Env, orgId: string, libraryId: string, opts: { fresh?: boolean } = {}): Promise<Choice> {
  const k = `${orgId}:${libraryId}`;
  const hit = cache.get(k);
  if (!opts.fresh && hit && Date.now() - hit.at < STORE_TTL_MS) return hit.choice;
  let choice: Choice = { kind: "managed" };
  if (env.PLATFORM_DB) {
    const r = await createMediaRepository(createSqlExecutor(env.PLATFORM_DB)).getStorageBackend(orgId, libraryId);
    if (r.ok && r.value.kind === "s3-compatible") choice = { kind: "remote", scope: { orgId, libraryId, backendId: r.value.id, prefix: r.value.prefix } };
    else if (!r.ok && r.error.kind !== "not_found") throw new StoreUnavailable();
  }
  cache.set(k, { at: Date.now(), choice });
  return choice;
}

/** The store for one library. Throws StoreUnavailable when its storage can't be reached from here. */
export async function storeFor(env: Env, orgId: string, libraryId: string, opts: { fresh?: boolean } = {}): Promise<MediaStore> {
  const c = await storeChoice(env, orgId, libraryId, opts);
  if (c.kind === "managed") {
    if (!env.MEDIA_BUCKET) throw new StoreUnavailable();
    const managed: MediaStore = env.MEDIA_BUCKET;
    return managed;
  }
  if (!env.STORAGE_WORKER) throw new StoreUnavailable();
  return remoteStore(env.STORAGE_WORKER, c.scope);
}
