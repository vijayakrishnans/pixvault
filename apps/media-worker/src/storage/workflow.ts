import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import type { Env } from "../env.js";
import type { Step } from "../pipeline/run.js";
import { runMigration, type MigrationParams } from "./migrate.js";

/** MigrateStorageWorkflow: one run per library storage migration (PV-47). */
export class MigrateStorageWorkflow extends WorkflowEntrypoint<Env, MigrationParams> {
  async run(event: WorkflowEvent<MigrationParams>, step: WorkflowStep): Promise<string> {
    return runMigration(this.env, event.payload, step as unknown as Step);
  }
}
