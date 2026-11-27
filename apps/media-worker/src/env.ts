export interface Env {
  PLATFORM_DB?: D1Database;
  MEMBERSHIP_WORKER?: Fetcher;
  POLICY_WORKER?: Fetcher;
  PROJECTS_WORKER?: Fetcher;
  /** The managed bucket (pixvault-<env>), from the cloudflare-r2 root's wiring. */
  MEDIA_BUCKET?: R2Bucket;
  /** Library maps and file routes for serve-worker (cloudflare-kv-media). */
  ROUTES_KV?: KVNamespace;
  /** Public origin of serve-worker, e.g. https://pixvault-serve-worker-stage.<sub>.workers.dev */
  SERVE_BASE?: string;
  /** One SQLite LibraryIndex Durable Object per library. */
  LIBRARY_INDEX?: DurableObjectNamespace;
  ENVIRONMENT: string;
}
