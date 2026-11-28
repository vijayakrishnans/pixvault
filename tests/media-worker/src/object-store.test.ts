// PV-13: commit verification must stream. workerd exposes the streaming digest as crypto.DigestStream; looking for
// a global once sent every commit down a buffered path that a 200 MB upload couldn't survive.
import { createHash, randomBytes } from "node:crypto";
import { MAX_BUFFERED_HASH_BYTES, sha256OfObject, streamingDigest } from "@media-worker/storage/object-store";
import { FakeBucket, FakeDigestStream } from "./harness.js";

describe("sha256OfObject", () => {
  const big = randomBytes(MAX_BUFFERED_HASH_BYTES + 36 * 1024 * 1024); // 100 MiB
  const c = (globalThis as unknown as { crypto: { DigestStream?: unknown } }).crypto;

  // Other suites in the same worker may leave it set; start each test without it.
  beforeEach(() => {
    delete c.DigestStream;
  });
  afterEach(() => {
    delete c.DigestStream;
  });

  it("finds the runtime's digest on crypto, not as a global", () => {
    expect(streamingDigest()).toBeNull();
    (globalThis as { DigestStream?: unknown }).DigestStream = FakeDigestStream; // a global alone doesn't count
    expect(streamingDigest()).toBeNull();
    delete (globalThis as { DigestStream?: unknown }).DigestStream;
    c.DigestStream = FakeDigestStream;
    expect(streamingDigest()).toBe(FakeDigestStream);
  });

  it("streams a large object through crypto.DigestStream", async () => {
    c.DigestStream = FakeDigestStream;
    const bucket = new FakeBucket();
    await bucket.put("k", big);
    const r = await sha256OfObject(bucket as unknown as R2Bucket, "k");
    expect(r).toEqual({ sha256: createHash("sha256").update(big).digest("hex"), size: big.length });
  }, 60_000);

  it("without a streaming digest, refuses to buffer more than 64 MiB", async () => {
    const bucket = new FakeBucket();
    await bucket.put("k", big);
    await expect(sha256OfObject(bucket as unknown as R2Bucket, "k")).rejects.toThrow(/refusing to buffer/);
    await bucket.put("small", big.subarray(0, 1024));
    expect((await sha256OfObject(bucket as unknown as R2Bucket, "small"))?.size).toBe(1024);
  }, 60_000);
});
