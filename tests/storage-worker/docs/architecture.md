# Architecture

Jest over the real `handle()` of storage-worker with a SQLite D1 (every migration applied) and s3rver on a random
local port. Test endpoints are allowed only through `ALLOW_TEST_ENDPOINTS`.
