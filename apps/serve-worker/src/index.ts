import type { Env } from "./env.js";
import { serve } from "./serve.js";

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    try {
      return await serve(request, env, { cache: (caches as unknown as { default: Cache }).default, waitUntil: (p) => ctx.waitUntil(p) });
    } catch (e) {
      console.error(JSON.stringify({ level: "error", msg: "serve_error", name: (e as Error)?.name, message: String((e as Error)?.message ?? e).slice(0, 200) }));
      return new Response("Unavailable", { status: 503, headers: { "cache-control": "no-store" } });
    }
  },
} satisfies ExportedHandler<Env>;
