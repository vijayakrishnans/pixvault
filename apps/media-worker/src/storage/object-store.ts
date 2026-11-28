// Derived from MarSeventh/CloudFlare-ImgBed@611153e:functions/utils/storage/s3Client.js (MIT), modified.
// The storage seam (design §4.4). PV2 implements the managed-R2 store over the Worker's R2 binding; the
// s3-compatible store for customer buckets (with presigned URLs) arrives in PV7.
//
// Managed uploads stream each part through this Worker into R2 (R2 multipart over the binding), so no S3 access
// key ever lives in a Worker and the bucket needs no CORS rule. Bytes never leave Cloudflare's network.

import type { MediaStore } from "@saas/shared/media-store";

export interface PartReceipt {
  partNumber: number;
  etag: string;
}

/** Store one whole object; R2 rejects it unless its SHA-256 matches. Returns false on a hash mismatch. */
export async function putSingle(
  bucket: MediaStore,
  key: string,
  body: ReadableStream,
  length: number,
  sha256Hex: string,
  contentType: string,
): Promise<"ok" | "hash_mismatch"> {
  try {
    await bucket.put(key, fixedLength(body, length), { sha256: sha256Hex, httpMetadata: { contentType } });
    return "ok";
  } catch (e) {
    if (/sha-?256|checksum|digest/i.test(String((e as Error)?.message))) return "hash_mismatch";
    throw e;
  }
}

export async function createMultipart(bucket: MediaStore, key: string, contentType: string): Promise<string> {
  const upload = await bucket.createMultipartUpload(key, { httpMetadata: { contentType } });
  return upload.uploadId;
}

export async function uploadPart(
  bucket: MediaStore,
  key: string,
  uploadId: string,
  partNumber: number,
  body: ReadableStream,
  length: number,
): Promise<PartReceipt> {
  const upload = bucket.resumeMultipartUpload(key, uploadId);
  const part = await upload.uploadPart(partNumber, fixedLength(body, length));
  return { partNumber: part.partNumber, etag: part.etag };
}

export async function completeMultipart(bucket: MediaStore, key: string, uploadId: string, parts: PartReceipt[]): Promise<void> {
  const upload = bucket.resumeMultipartUpload(key, uploadId);
  await upload.complete(parts.sort((a, b) => a.partNumber - b.partNumber));
}

export async function abortUpload(bucket: MediaStore, key: string, mode: string, uploadId: string | null): Promise<void> {
  try {
    if (mode === "multipart" && uploadId) await bucket.resumeMultipartUpload(key, uploadId).abort();
    else await bucket.delete(key);
  } catch {
    /* already gone */
  }
}

/** Largest object the buffered fallback will hash. Workers have 128 MB of memory; production never takes this path. */
export const MAX_BUFFERED_HASH_BYTES = 64 * 1024 * 1024;

type DigestStreamCtor = new (algorithm: string) => WritableStream<ArrayBuffer | ArrayBufferView> & { digest: Promise<ArrayBuffer> };

/**
 * The runtime's streaming digest. In workerd it is `crypto.DigestStream` (a property of `crypto`, not a global).
 * Looking for a global once sent every commit down the buffered path, and a 200 MB file hit the memory limit
 * (PV-13).
 */
export function streamingDigest(): DigestStreamCtor | null {
  const c = (globalThis as { crypto?: { DigestStream?: unknown } }).crypto;
  return typeof c?.DigestStream === "function" ? (c.DigestStream as DigestStreamCtor) : null;
}

/** SHA-256 (hex) of a stored object, streamed through the runtime's digest stream: constant memory at any size. */
export async function sha256OfObject(bucket: MediaStore, key: string): Promise<{ sha256: string; size: number } | null> {
  const obj = await bucket.get(key);
  if (!obj) return null;
  let bytes: Uint8Array;
  const Digest = streamingDigest();
  if (Digest) {
    const digest = new Digest("SHA-256");
    await obj.body.pipeTo(digest);
    bytes = new Uint8Array(await digest.digest);
  } else {
    // Only outside workerd (tests). Refuse to buffer anything that wouldn't fit a Worker, so a missing streaming
    // digest fails loudly instead of running out of memory in production.
    if (obj.size > MAX_BUFFERED_HASH_BYTES) {
      await obj.body.cancel();
      throw new Error(`no streaming digest available; refusing to buffer ${obj.size} bytes`);
    }
    bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", await new Response(obj.body).arrayBuffer()));
  }
  return { sha256: Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join(""), size: obj.size };
}

/** R2 needs a known length for a streamed body. */
function fixedLength(body: ReadableStream, length: number): ReadableStream {
  if (typeof FixedLengthStream === "undefined") return body;
  return body.pipeThrough(new FixedLengthStream(length));
}
