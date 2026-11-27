export interface Env {
  PLATFORM_DB?: D1Database;
  MEMBERSHIP_WORKER?: Fetcher;
  POLICY_WORKER?: Fetcher;
  PROJECTS_WORKER?: Fetcher;
  /** The managed bucket (pixvault-<env>), from the cloudflare-r2 root's wiring. */
  MEDIA_BUCKET?: R2Bucket;
  /** One SQLite LibraryIndex Durable Object per library. */
  LIBRARY_INDEX?: DurableObjectNamespace;
  ENVIRONMENT: string;
}
