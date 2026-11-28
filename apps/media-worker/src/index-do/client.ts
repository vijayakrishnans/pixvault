import type { Env } from "../env.js";
import type { IndexOp, IndexResult } from "./library-index.js";
import type { Scope } from "./core.js";

export class IndexCallError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
  }
}

export interface LibraryIndexClient {
  call<T>(req: IndexOp): Promise<T>;
}

interface IndexStub {
  call(scope: Scope, req: IndexOp): Promise<IndexResult>;
}

/** The Durable Object itself, for the live socket (a fetch, not an RPC call). */
export function indexStub(env: Env, scope: Scope): { fetch(request: Request): Promise<Response> } {
  const ns = env.LIBRARY_INDEX!;
  return ns.get(ns.idFromName(`org:${scope.orgId}:lib:${scope.libraryId}`)) as unknown as { fetch(request: Request): Promise<Response> };
}

/**
 * The index of one library. The DO's name binds it to (org, library), and every call restates the scope. `scope.actor`
 * says who is acting, for the activity log.
 */
export function indexFor(env: Env, scope: Scope): LibraryIndexClient {
  const ns = env.LIBRARY_INDEX!;
  const stub = ns.get(ns.idFromName(`org:${scope.orgId}:lib:${scope.libraryId}`)) as unknown as IndexStub;
  return {
    async call<T>(req: IndexOp): Promise<T> {
      const r = await stub.call(scope, req);
      if (!r.ok) throw new IndexCallError(r.code, r.message);
      return r.value as T;
    },
  };
}
