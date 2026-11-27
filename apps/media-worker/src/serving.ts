// What serve-worker reads about a library, and the URLs media-worker hands out (design §2.5).
//
// KV `lib:<orgSlug>/<libSlug>` holds the library's serving map: ids, default visibility, access rules, presets and
// the signing keys by version. File routes are written by the library's index outbox (index-do/routes.ts).

import { newSigningKey, signPath } from "@saas/shared/media-signing";
import type { Library } from "@saas/db/media";
import type { Ctx } from "./ctx.js";
import type { Env } from "./env.js";
import { indexFor } from "./index-do/client.js";
import { logError } from "./log.js";
import { orgPublicId } from "./ids.js";
import { parseSettings } from "./handlers/libraries.js";
import type { ActorContext } from "./router.js";

export interface LibraryMap {
  /** org id */ o: string;
  /** library id */ l: string;
  /** default visibility */ v: "public" | "private";
  /** signing keys by version */ k: Record<string, string>;
  /** allowed referrer hosts (empty = any) */ r: string[];
  /** IP allow list (empty = any) */ ia: string[];
  /** IP block list */ ib: string[];
  /** random-image API enabled */ rnd: boolean;
  /** allowed transform presets */ p: string[];
}

export const libraryMapKey = (orgSlug: string, libSlug: string) => `lib:${orgSlug}/${libSlug}`;

export function toLibraryMap(lib: Library): LibraryMap | null {
  if (!lib.signingKey) return null;
  const s = parseSettings(lib.settingsJson);
  return {
    o: lib.orgId,
    l: lib.id,
    v: lib.visibilityDefault,
    k: { [String(lib.signingKeyVersion)]: lib.signingKey },
    r: s.allowedReferrers,
    ia: s.ipAllowList,
    ib: s.ipBlockList,
    rnd: s.randomApiEnabled,
    p: s.transformPresets,
  };
}

export async function publishLibraryMap(env: Env, lib: Library): Promise<void> {
  const map = toLibraryMap(lib);
  if (!env.ROUTES_KV || !lib.orgSlug || !map || lib.status !== "active") return;
  await env.ROUTES_KV.put(libraryMapKey(lib.orgSlug, lib.slug), JSON.stringify(map));
}

export async function unpublishLibraryMap(env: Env, lib: Library): Promise<void> {
  if (!env.ROUTES_KV || !lib.orgSlug) return;
  await env.ROUTES_KV.delete(libraryMapKey(lib.orgSlug, lib.slug));
}

/** The org's slug, read through membership-worker as the caller (members only). */
export async function fetchOrgSlug(env: Env, actor: ActorContext, orgId: string, requestId: string): Promise<string | null> {
  if (!env.MEMBERSHIP_WORKER) return null;
  try {
    const res = await env.MEMBERSHIP_WORKER.fetch(`https://membership.internal/v1/organizations/${orgPublicId(orgId)}`, {
      headers: {
        "x-request-id": requestId,
        "x-actor-subject-id": actor.subjectId,
        "x-actor-subject-type": actor.subjectType,
        ...(actor.email ? { "x-actor-email": actor.email } : {}),
      },
    });
    if (!res.ok) return null;
    const json = (await res.json()) as { data?: { organization?: { slug?: string }; slug?: string } };
    const slug = json.data?.organization?.slug ?? json.data?.slug;
    return typeof slug === "string" && /^[a-z0-9][a-z0-9-]{0,62}$/.test(slug) ? slug : null;
  } catch {
    return null;
  }
}

/**
 * Make sure a library can be served: it has its org slug and a signing key, its map is published, and (the first
 * time) every existing file's route is queued. Libraries created after PV3 already have both; older ones are
 * filled in the first time a member reads them. Never fails the caller's request.
 */
export async function ensureServing(ctx: Ctx, lib: Library): Promise<Library> {
  if (lib.orgSlug && lib.signingKey) return lib;
  try {
    const slug = lib.orgSlug ?? (await fetchOrgSlug(ctx.env, ctx.actor, lib.orgId, ctx.requestId));
    if (!slug) return lib; // a guest can't read the org; a member will fill it in
    const updated = await ctx.repo.setServingIdentity(lib.orgId, lib.id, slug, newSigningKey(), ctx.now());
    if (!updated.ok) return lib;
    await publishLibraryMap(ctx.env, updated.value);
    if (ctx.env.LIBRARY_INDEX) {
      await indexFor(ctx.env, { orgId: lib.orgId, libraryId: lib.id }).call({ op: "requeueAllRoutes", nowIso: ctx.now().toISOString() });
    }
    return updated.value;
  } catch (e) {
    logError(ctx.requestId, "ensureServing", e);
    return lib;
  }
}

const encodePath = (path: string) => path.split("/").map(encodeURIComponent).join("/");

/** Public URL of a path in this library, or null when serving isn't configured for it yet. */
export function fileUrl(env: Env, lib: Library, path: string): string | null {
  if (!env.SERVE_BASE || !lib.orgSlug) return null;
  return `${env.SERVE_BASE.replace(/\/+$/, "")}/${lib.orgSlug}/${lib.slug}${encodePath(path)}`;
}

/** A signed URL for `path`, valid for `expiresInSeconds`. */
export async function signedFileUrl(env: Env, lib: Library, path: string, expiresInSeconds: number, now: Date): Promise<{ url: string; expiresAt: string } | null> {
  const base = fileUrl(env, lib, path);
  if (!base || !lib.signingKey) return null;
  const exp = Math.floor(now.getTime() / 1000) + expiresInSeconds;
  const sig = await signPath(lib.signingKey, lib.signingKeyVersion, lib.id, path, exp);
  return { url: `${base}?exp=${exp}&sig=${encodeURIComponent(sig)}`, expiresAt: new Date(exp * 1000).toISOString() };
}
