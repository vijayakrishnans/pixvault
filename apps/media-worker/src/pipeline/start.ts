// Starting ProcessFileWorkflow for one file version. Used after a commit, a replay, a visibility change that needs
// a safety check, and by the index's sweep for runs that were lost.

import type { Env } from "../env.js";

export interface PipelineParams {
  orgId: string;
  libraryId: string;
  fileId: string;
  sha256: string;
  /** The library's visibility rule at start: a public file on a free plan must pass moderation (PV-23). */
  requireSafety: boolean;
}

/** Instance ids are unique per file version and attempt, so a retry never collides with an earlier run. */
export function instanceId(p: Pick<PipelineParams, "fileId" | "sha256">, attempt: string): string {
  return `f${p.fileId.replace(/-/g, "")}-${p.sha256.slice(0, 16)}-${attempt}`.slice(0, 100);
}

/** Start the pipeline. Returns false when it couldn't be started; the index's sweep tries again later. */
export async function startPipeline(env: Env, p: PipelineParams, attempt = "a"): Promise<boolean> {
  if (!env.PROCESS_FILE) return false;
  try {
    await env.PROCESS_FILE.create({ id: instanceId(p, attempt), params: p });
    return true;
  } catch (e) {
    console.error(JSON.stringify({ level: "error", msg: "pipeline_start_failed", file: p.fileId, name: (e as Error)?.name, message: String((e as Error)?.message ?? e).slice(0, 200) }));
    return false;
  }
}

/** Which uploads go through the pipeline before they are served. */
export function needsPipeline(mime: string, visibility: "public" | "private", freePlan: boolean): boolean {
  return /^image\//i.test(mime) || (visibility === "public" && freePlan);
}
