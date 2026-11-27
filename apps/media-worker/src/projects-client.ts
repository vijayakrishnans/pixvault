// A library is a Cirrus project. Creating one goes through projects-worker as the caller, so the project's own
// policy check (project.create) and billing gate (limit.projects) apply unchanged.

import type { CreateProjectResponse } from "@saas/contracts/projects";
import type { ActorContext } from "./router.js";

export type CreateProjectOutcome =
  | { kind: "ok"; projectPublicId: string }
  | { kind: "conflict" }
  | { kind: "denied" }
  | { kind: "limit"; status: number; body: unknown }
  | { kind: "error" };

function actorHeaders(actor: ActorContext, requestId: string): Headers {
  const h = new Headers();
  h.set("content-type", "application/json");
  h.set("x-request-id", requestId);
  h.set("x-actor-subject-id", actor.subjectId);
  h.set("x-actor-subject-type", actor.subjectType);
  if (actor.email) h.set("x-actor-email", actor.email);
  return h;
}

export async function createProject(
  projectsWorker: Fetcher,
  actor: ActorContext,
  orgPublicId: string,
  name: string,
  slug: string,
  requestId: string,
): Promise<CreateProjectOutcome> {
  let res: Response;
  try {
    res = await projectsWorker.fetch(`https://projects.internal/v1/organizations/${orgPublicId}/projects`, {
      method: "POST",
      headers: actorHeaders(actor, requestId),
      body: JSON.stringify({ name, slug }),
    });
  } catch {
    return { kind: "error" };
  }
  if (res.status === 201) {
    try {
      const json = (await res.json()) as { data?: CreateProjectResponse };
      const id = json.data?.project?.id;
      return id ? { kind: "ok", projectPublicId: id } : { kind: "error" };
    } catch {
      return { kind: "error" };
    }
  }
  if (res.status === 409) return { kind: "conflict" };
  if (res.status === 404 || res.status === 403) return { kind: "denied" };
  if (res.status === 412 || res.status === 402) {
    let body: unknown = null;
    try {
      body = await res.json();
    } catch {
      /* keep null */
    }
    return { kind: "limit", status: res.status, body };
  }
  return { kind: "error" };
}

export async function archiveProject(
  projectsWorker: Fetcher,
  actor: ActorContext,
  orgPublicId: string,
  projectPublicId: string,
  requestId: string,
): Promise<boolean> {
  try {
    const res = await projectsWorker.fetch(
      `https://projects.internal/v1/organizations/${orgPublicId}/projects/${projectPublicId}`,
      { method: "DELETE", headers: actorHeaders(actor, requestId) },
    );
    return res.ok || res.status === 404;
  } catch {
    return false;
  }
}
