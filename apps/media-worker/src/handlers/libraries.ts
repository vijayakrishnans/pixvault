import type {
  CreateLibraryRequest,
  LibrarySettings,
  PublicLibrary,
  UpdateLibraryRequest,
} from "@saas/contracts/media";
import { DEFAULT_LIBRARY_SETTINGS } from "@saas/contracts/media";
import type { Library } from "@saas/db/media";
import { authorizeCreate, authorizeOnLibrary, displayRole, hasAnyStanding, loadFacts, type AccessFacts } from "../access.js";
import { audit, type Ctx } from "../ctx.js";
import { errorResponse, successResponse, validationError } from "../http.js";
import { logError } from "../log.js";
import { actorUuid, libraryPublicId, orgPublicId, parseProjectPublicId, projectPublicId } from "../ids.js";
import { archiveProject, createProject } from "../projects-client.js";

const NAME_MAX = 100;
const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const MAX_LIST = 50;
const MAX_UPLOAD_CEILING = 5 * 1024 * 1024 * 1024; // 5 GiB

export function parseSettings(json: string): LibrarySettings {
  let raw: unknown = {};
  try {
    raw = JSON.parse(json);
  } catch {
    raw = {};
  }
  const r = (raw && typeof raw === "object" ? raw : {}) as Partial<LibrarySettings>;
  return { ...DEFAULT_LIBRARY_SETTINGS, ...r };
}

export function toPublicLibrary(lib: Library, facts: AccessFacts | null): PublicLibrary {
  return {
    id: libraryPublicId(lib.id),
    orgId: orgPublicId(lib.orgId),
    projectId: projectPublicId(lib.projectId),
    slug: lib.slug,
    name: lib.name,
    visibilityDefault: lib.visibilityDefault,
    everyoneInOrg: lib.everyoneInOrg,
    moderationLevel: lib.moderationLevel,
    retentionDays: lib.retentionDays,
    settings: parseSettings(lib.settingsJson),
    status: lib.status,
    myRole: facts ? displayRole(lib, facts) : null,
    createdAt: lib.createdAt.toISOString(),
    updatedAt: lib.updatedAt.toISOString(),
  };
}

function deriveSlug(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 63)
      .replace(/-+$/g, "") || "library"
  );
}

const isStrList = (v: unknown): v is string[] =>
  Array.isArray(v) && v.length <= MAX_LIST && v.every((x) => typeof x === "string" && x.length > 0 && x.length <= 200);

export function validateSettingsPatch(v: unknown, fields: Record<string, string[]>): Partial<LibrarySettings> {
  if (v === undefined) return {};
  if (!v || typeof v !== "object" || Array.isArray(v)) {
    fields.settings = ["Must be an object"];
    return {};
  }
  const s = v as Record<string, unknown>;
  const out: Partial<LibrarySettings> = {};
  for (const key of ["allowedTypes", "allowedReferrers", "ipAllowList", "ipBlockList", "transformPresets"] as const) {
    if (s[key] === undefined) continue;
    if (!isStrList(s[key])) fields[`settings.${key}`] = [`Must be a list of at most ${MAX_LIST} non-empty strings`];
    else out[key] = s[key] as string[];
  }
  if (s.maxUploadBytes !== undefined) {
    const n = s.maxUploadBytes;
    if (n === null) out.maxUploadBytes = null;
    else if (typeof n !== "number" || !Number.isInteger(n) || n < 1 || n > MAX_UPLOAD_CEILING) {
      fields["settings.maxUploadBytes"] = [`Must be null or an integer from 1 to ${MAX_UPLOAD_CEILING}`];
    } else out.maxUploadBytes = n;
  }
  if (s.randomApiEnabled !== undefined) {
    if (typeof s.randomApiEnabled !== "boolean") fields["settings.randomApiEnabled"] = ["Must be a boolean"];
    else out.randomApiEnabled = s.randomApiEnabled;
  }
  const known = new Set([
    "allowedTypes",
    "allowedReferrers",
    "ipAllowList",
    "ipBlockList",
    "transformPresets",
    "maxUploadBytes",
    "randomApiEnabled",
  ]);
  for (const k of Object.keys(s)) if (!known.has(k)) fields[`settings.${k}`] = ["Unknown setting"];
  return out;
}

async function readJson(request: Request): Promise<{ ok: true; body: unknown } | { ok: false }> {
  try {
    return { ok: true, body: await request.json() };
  } catch {
    return { ok: false };
  }
}

/** GET /v1/organizations/{org}/libraries: libraries the caller may read. */
export async function handleListLibraries(ctx: Ctx, orgId: string): Promise<Response> {
  const facts = await loadFacts(ctx.env, ctx.repo, ctx.actor, orgId, ctx.requestId);
  if (!facts.ok) return errorResponse("internal_error", "Service unavailable", 503, ctx.requestId);
  if (!hasAnyStanding(facts.facts)) return errorResponse("not_found", "Not found", 404, ctx.requestId);
  const libs = await ctx.repo.listLibraries(orgId);
  if (!libs.ok) return errorResponse("internal_error", "Service unavailable", 503, ctx.requestId);
  const decisions = await Promise.all(
    libs.value.map((l) => authorizeOnLibrary(ctx.env, ctx.actor, "library.read", l, facts.facts, ctx.requestId)),
  );
  const visible = libs.value.filter((_, i) => decisions[i]);
  return successResponse({ libraries: visible.map((l) => toPublicLibrary(l, facts.facts)) }, ctx.requestId);
}

/** POST /v1/organizations/{org}/libraries */
export async function handleCreateLibrary(ctx: Ctx, request: Request, orgId: string): Promise<Response> {
  const parsed = await readJson(request);
  if (!parsed.ok) return validationError(ctx.requestId, { body: ["Invalid JSON"] });
  const b = (parsed.body ?? {}) as Partial<CreateLibraryRequest> & Record<string, unknown>;
  const fields: Record<string, string[]> = {};
  if (typeof b.name !== "string" || b.name.trim().length < 1 || b.name.length > NAME_MAX) {
    fields.name = [`Must be a string between 1 and ${NAME_MAX} characters`];
  }
  const slug = b.slug === undefined || b.slug === null ? deriveSlug(typeof b.name === "string" ? b.name : "") : b.slug;
  if (typeof slug !== "string" || slug.length < 2 || !SLUG_RE.test(slug)) {
    fields.slug = ["Must be 2-63 lowercase letters, numbers or hyphens, starting and ending with a letter or number"];
  }
  if (b.visibilityDefault !== undefined && b.visibilityDefault !== "public" && b.visibilityDefault !== "private") {
    fields.visibilityDefault = ["Must be public or private"];
  }
  if (b.everyoneInOrg !== undefined && typeof b.everyoneInOrg !== "boolean") fields.everyoneInOrg = ["Must be a boolean"];
  if (Object.keys(fields).length) return validationError(ctx.requestId, fields);

  const facts = await loadFacts(ctx.env, ctx.repo, ctx.actor, orgId, ctx.requestId);
  if (!facts.ok) return errorResponse("internal_error", "Service unavailable", 503, ctx.requestId);
  if (!(await authorizeCreate(ctx.env, ctx.actor, orgId, facts.facts, ctx.requestId))) {
    return errorResponse("not_found", "Not found", 404, ctx.requestId);
  }

  const name = (b.name as string).trim();
  const project = await createProject(ctx.env.PROJECTS_WORKER!, ctx.actor, orgPublicId(orgId), name, slug as string, ctx.requestId);
  if (project.kind === "conflict") return errorResponse("conflict", "A library with this slug already exists", 409, ctx.requestId);
  if (project.kind === "denied") return errorResponse("not_found", "Not found", 404, ctx.requestId);
  if (project.kind === "limit") {
    return errorResponse("precondition_failed", "Your plan's library limit is reached", 412, ctx.requestId, {
      reason: "limit.projects",
    });
  }
  if (project.kind !== "ok") return errorResponse("internal_error", "Service unavailable", 503, ctx.requestId);
  const projectId = parseProjectPublicId(project.projectPublicId);
  if (!projectId) return errorResponse("internal_error", "Service unavailable", 503, ctx.requestId);

  const libraryId = crypto.randomUUID();
  const created = await ctx.repo.createLibrary({
    id: libraryId,
    orgId,
    projectId,
    slug: slug as string,
    name,
    visibilityDefault: b.visibilityDefault ?? "private",
    everyoneInOrg: b.everyoneInOrg ?? false,
    settingsJson: JSON.stringify(DEFAULT_LIBRARY_SETTINGS),
    createdBy: actorUuid(ctx.actor.subjectId),
    creator: ctx.actor.subjectType === "user" ? { principalId: ctx.actor.subjectId, email: ctx.actor.email || null } : undefined,
    storageBackendId: crypto.randomUUID(),
    createdAt: ctx.now(),
  });
  if (!created.ok) {
    // Compensate: the project exists but the library row doesn't.
    await archiveProject(ctx.env.PROJECTS_WORKER!, ctx.actor, orgPublicId(orgId), project.projectPublicId, ctx.requestId);
    if (created.error.kind === "conflict") {
      return errorResponse("conflict", "A library with this slug already exists", 409, ctx.requestId);
    }
    return errorResponse("internal_error", "Service unavailable", 503, ctx.requestId);
  }
  const lib = created.value;
  await audit(ctx, lib, "library.created", `Created library "${lib.name}"`, { slug: lib.slug });
  const after = await loadFacts(ctx.env, ctx.repo, ctx.actor, orgId, ctx.requestId);
  return successResponse({ library: toPublicLibrary(lib, after.ok ? after.facts : facts.facts) }, ctx.requestId, 201);
}

/** Load a library in this org and check one action; returns 404 for missing, other-org or denied. */
export async function loadAuthorized(
  ctx: Ctx,
  orgId: string,
  libraryId: string,
  action: Parameters<typeof authorizeOnLibrary>[2],
): Promise<{ ok: true; lib: Library; facts: AccessFacts } | { ok: false; response: Response }> {
  const [lib, facts] = await Promise.all([
    ctx.repo.getLibrary(orgId, libraryId),
    loadFacts(ctx.env, ctx.repo, ctx.actor, orgId, ctx.requestId),
  ]);
  if (!facts.ok) {
    logError(ctx.requestId, "loadAuthorized.facts", "membership or library roles unavailable");
    return { ok: false, response: errorResponse("internal_error", "Service unavailable", 503, ctx.requestId) };
  }
  if (!lib.ok) {
    if (lib.error.kind !== "not_found") logError(ctx.requestId, "loadAuthorized.library", lib.error.kind === "internal" ? lib.error.message : lib.error.kind);
    return lib.error.kind === "not_found"
      ? { ok: false, response: errorResponse("not_found", "Not found", 404, ctx.requestId) }
      : { ok: false, response: errorResponse("internal_error", "Service unavailable", 503, ctx.requestId) };
  }
  if (lib.value.status !== "active") return { ok: false, response: errorResponse("not_found", "Not found", 404, ctx.requestId) };
  if (!(await authorizeOnLibrary(ctx.env, ctx.actor, action, lib.value, facts.facts, ctx.requestId))) {
    return { ok: false, response: errorResponse("not_found", "Not found", 404, ctx.requestId) };
  }
  return { ok: true, lib: lib.value, facts: facts.facts };
}

/** GET /v1/organizations/{org}/libraries/{lib} */
export async function handleGetLibrary(ctx: Ctx, orgId: string, libraryId: string): Promise<Response> {
  const a = await loadAuthorized(ctx, orgId, libraryId, "library.read");
  if (!a.ok) return a.response;
  return successResponse({ library: toPublicLibrary(a.lib, a.facts) }, ctx.requestId);
}

/** PATCH /v1/organizations/{org}/libraries/{lib} */
export async function handleUpdateLibrary(ctx: Ctx, request: Request, orgId: string, libraryId: string): Promise<Response> {
  const parsed = await readJson(request);
  if (!parsed.ok) return validationError(ctx.requestId, { body: ["Invalid JSON"] });
  const b = (parsed.body ?? {}) as UpdateLibraryRequest & Record<string, unknown>;
  const fields: Record<string, string[]> = {};
  if (b.name !== undefined && (typeof b.name !== "string" || b.name.trim().length < 1 || b.name.length > NAME_MAX)) {
    fields.name = [`Must be a string between 1 and ${NAME_MAX} characters`];
  }
  if (b.visibilityDefault !== undefined && b.visibilityDefault !== "public" && b.visibilityDefault !== "private") {
    fields.visibilityDefault = ["Must be public or private"];
  }
  if (b.everyoneInOrg !== undefined && typeof b.everyoneInOrg !== "boolean") fields.everyoneInOrg = ["Must be a boolean"];
  if (b.moderationLevel !== undefined && !["off", "standard", "strict"].includes(b.moderationLevel as string)) {
    fields.moderationLevel = ["Must be off, standard or strict"];
  }
  if (
    b.retentionDays !== undefined &&
    (typeof b.retentionDays !== "number" || !Number.isInteger(b.retentionDays) || b.retentionDays < 1 || b.retentionDays > 3650)
  ) {
    fields.retentionDays = ["Must be an integer from 1 to 3650"];
  }
  const settingsPatch = validateSettingsPatch(b.settings, fields);
  for (const k of Object.keys(b)) {
    if (!["name", "visibilityDefault", "everyoneInOrg", "moderationLevel", "retentionDays", "settings"].includes(k)) {
      fields[k] = ["Unknown field"];
    }
  }
  if (Object.keys(fields).length) return validationError(ctx.requestId, fields);

  const a = await loadAuthorized(ctx, orgId, libraryId, "library.update");
  if (!a.ok) return a.response;
  const settingsJson =
    b.settings !== undefined ? JSON.stringify({ ...parseSettings(a.lib.settingsJson), ...settingsPatch }) : undefined;
  const updated = await ctx.repo.updateLibrary(orgId, libraryId, {
    name: typeof b.name === "string" ? b.name.trim() : undefined,
    visibilityDefault: b.visibilityDefault,
    everyoneInOrg: b.everyoneInOrg,
    moderationLevel: b.moderationLevel,
    retentionDays: b.retentionDays,
    settingsJson,
    updatedAt: ctx.now(),
  });
  if (!updated.ok) {
    return updated.error.kind === "not_found"
      ? errorResponse("not_found", "Not found", 404, ctx.requestId)
      : errorResponse("internal_error", "Service unavailable", 503, ctx.requestId);
  }
  await audit(ctx, updated.value, "library.updated", `Updated library "${updated.value.name}"`, {
    fields: Object.keys(b),
  });
  return successResponse({ library: toPublicLibrary(updated.value, a.facts) }, ctx.requestId);
}

/** DELETE /v1/organizations/{org}/libraries/{lib}: archive the library and its project. Files are untouched. */
export async function handleArchiveLibrary(ctx: Ctx, orgId: string, libraryId: string): Promise<Response> {
  const a = await loadAuthorized(ctx, orgId, libraryId, "library.delete");
  if (!a.ok) return a.response;
  const archived = await ctx.repo.archiveLibrary(orgId, libraryId, ctx.now());
  if (!archived.ok) {
    return archived.error.kind === "not_found"
      ? errorResponse("not_found", "Not found", 404, ctx.requestId)
      : errorResponse("internal_error", "Service unavailable", 503, ctx.requestId);
  }
  await archiveProject(ctx.env.PROJECTS_WORKER!, ctx.actor, orgPublicId(orgId), projectPublicId(a.lib.projectId), ctx.requestId);
  await audit(ctx, archived.value, "library.archived", `Archived library "${archived.value.name}"`, {});
  return successResponse({ library: toPublicLibrary(archived.value, a.facts) }, ctx.requestId);
}
