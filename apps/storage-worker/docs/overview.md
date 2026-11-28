# storage-worker

Pixvault's adapter for customer S3-compatible buckets (PV7). It tests a bucket, stores its access key and secret
envelope-encrypted, checks its health, and runs object operations on it. It is the only place those credentials are
opened, for one request at a time. It has no public route: media-worker and serve-worker call it over service
bindings after authorising the caller.
