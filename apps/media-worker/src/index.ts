import type { Env } from "./env.js";
import { route } from "./router.js";

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    return route(request, env);
  },
} satisfies ExportedHandler<Env>;

export { LibraryIndex } from "./index-do/library-index.js";
export { ProcessFileWorkflow } from "./pipeline/workflow.js";
export { MigrateStorageWorkflow } from "./storage/workflow.js";
