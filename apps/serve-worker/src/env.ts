export interface Env {
  ENVIRONMENT?: string;
  /** "on" | "off": serving without a signature (public files, random API). Unset: off in prod (risk PV-A, W-5/W-6). */
  PUBLIC_SHARING?: string;
  /** Library maps and file routes (cloudflare-kv-media). */
  ROUTES_KV?: KVNamespace;
  /** The managed bucket (cloudflare-r2), read-only here. */
  MEDIA_BUCKET?: R2Bucket;
  /** Cloudflare Images binding, for preset transforms. */
  IMAGES?: ImagesBinding;
  /** One data point per serve. */
  SERVE_AE?: AnalyticsEngineDataset;
  /** Per-IP rate limit. */
  SERVE_RL?: RateLimit;
  /** media-worker (service binding): abuse reports from the report form. */
  MEDIA_WORKER?: Fetcher;
  /** Upload-link submissions per address. */
  SERVE_UPLOAD_RL?: RateLimit;
  /** Password tries on a share link: per address and link. */
  SERVE_SHARE_RL?: RateLimit;
  /** Per-IP limit on abuse reports. */
  SERVE_REPORT_RL?: RateLimit;
  /** media-worker's LibraryIndex (random-image API). */
  LIBRARY_INDEX?: DurableObjectNamespace;
}
