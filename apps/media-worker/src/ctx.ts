import type { Library, MediaRepository } from "@saas/db/media";
import type { EventsRepository } from "@saas/db/events";
import type { Env } from "./env.js";
import { libraryPublicId, orgPublicId, projectPublicId } from "./ids.js";
import type { ActorContext } from "./router.js";

/** Everything a handler needs, built once per request (and by tests, over a real SQLite D1). */
export interface Ctx {
  env: Env;
  repo: MediaRepository;
  events: EventsRepository;
  actor: ActorContext;
  requestId: string;
  now: () => Date;
}

/**
 * Append the event and its audit entry. D1 has no interactive transactions, so this follows the write it records
 * (as projects-worker does); a failure is logged by request id and never leaks payload contents.
 */
export async function audit(
  ctx: Ctx,
  lib: Library,
  type: string,
  description: string,
  payload: Record<string, unknown>,
): Promise<void> {
  const eventId = crypto.randomUUID();
  const result = await ctx.events.appendEventWithAudit({
    event: {
      id: eventId,
      type,
      version: 1,
      source: "media-worker",
      occurredAt: ctx.now(),
      actorType: ctx.actor.subjectType,
      actorId: ctx.actor.subjectId,
      orgId: lib.orgId,
      projectId: lib.projectId,
      subjectKind: "library",
      subjectId: lib.id,
      subjectName: lib.name,
      requestId: ctx.requestId,
      payload: {
        libraryId: libraryPublicId(lib.id),
        orgId: orgPublicId(lib.orgId),
        projectId: projectPublicId(lib.projectId),
        ...payload,
      },
    },
    audit: {
      id: crypto.randomUUID(),
      category: "media",
      description,
      projectId: lib.projectId,
    },
  });
  if (!result.ok) {
    console.error(JSON.stringify({ level: "error", msg: "audit_append_failed", type, requestId: ctx.requestId }));
  }
}
