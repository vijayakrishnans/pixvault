import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import type { Env } from "../env.js";
import { runPipeline, type Step } from "./run.js";
import type { PipelineParams } from "./start.js";

/** ProcessFileWorkflow: one run per file version (design §4.3, Workflows instead of a queue). */
export class ProcessFileWorkflow extends WorkflowEntrypoint<Env, PipelineParams> {
  async run(event: WorkflowEvent<PipelineParams>, step: WorkflowStep): Promise<string> {
    return runPipeline(this.env, event.payload, step as unknown as Step);
  }
}
