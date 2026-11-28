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
  /** ProcessFileWorkflow (PV4): metadata, GPS removal, moderation, tags. */
  PROCESS_FILE?: Workflow<import("./pipeline/start.js").PipelineParams>;
  /** Cloudflare Images binding: image info and the small copy sent to moderation. */
  IMAGES?: ImagesBinding;
  /** Workers AI: moderation and tags. */
  AI?: Ai;
  /** Workers AI model names (vars), so a model can change without a code change. */
  MODERATION_MODEL?: string;
  TAGS_MODEL?: string;
  /** One SQLite LibraryIndex Durable Object per library. */
  LIBRARY_INDEX?: DurableObjectNamespace;
  ENVIRONMENT: string;
  /** notifications-worker (service binding): mention emails (PV6). */
  NOTIFICATIONS_WORKER?: Fetcher;
  /** The media app's origin, for links in emails (e.g. https://pixvault-media-web-stage.<sub>.workers.dev). */
  APP_BASE?: string;
  /** storage-worker (service binding): customer buckets (PV7). */
  STORAGE_WORKER?: Fetcher;
  /** "on" | "off": public files, share links, upload links, galleries (off in prod until W-5/W-6; see sharing.ts). */
  PUBLIC_SHARING?: string;
}
