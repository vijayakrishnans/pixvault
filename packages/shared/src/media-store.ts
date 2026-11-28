// The storage seam shared by media-worker and serve-worker (design §4.4; PV7). A library's files live either in
// managed R2 (the Worker's R2 binding, which already has this shape) or in the customer's own bucket, reached through
// storage-worker over a service binding. Only storage-worker can open the bucket's credentials; this side knows the
// backend's id and key prefix, nothing secret.
//
// Keys stay the same in both places: in a customer bucket an object sits at the backend's prefix plus the managed key,
// so the library's index never changes when its storage does.

export interface StoredObject {
  body: ReadableStream;
  /** The whole object's size, even for a ranged read. */
  size: number;
  arrayBuffer(): Promise<ArrayBuffer>;
}

export interface UploadedPart {
  partNumber: number;
  etag: string;
}

export interface MultipartHandle {
  uploadPart(partNumber: number, body: ReadableStream | ArrayBuffer | ArrayBufferView): Promise<UploadedPart>;
  complete(parts: UploadedPart[]): Promise<unknown>;
  abort(): Promise<void>;
}

/** The subset of R2Bucket the product uses; an R2Bucket is one. */
export interface MediaStore {
  get(key: string, options?: { range?: { offset: number; length: number } }): Promise<StoredObject | null>;
  put(key: string, body: ReadableStream | ArrayBuffer | ArrayBufferView, options?: { sha256?: string; httpMetadata?: { contentType?: string } }): Promise<unknown>;
  delete(key: string): Promise<void>;
  createMultipartUpload(key: string, options?: { httpMetadata?: { contentType?: string } }): Promise<{ uploadId: string }>;
  resumeMultipartUpload(key: string, uploadId: string): MultipartHandle;
}

export interface RemoteScope {
  orgId: string;
  libraryId: string;
  backendId: string;
  /** The backend's key prefix ("" or ending in "/"). */
  prefix: string;
}

export interface StorageFetcher {
  fetch(input: string, init?: RequestInit): Promise<Response>;
}

/** Thrown for a refused call; carries storage-worker's code, never a URL or a key. */
export class StoreError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(`storage ${status} ${code}`);
    this.name = "StoreError";
  }
}

async function errorOf(res: Response): Promise<StoreError> {
  let code = "storage_error";
  try {
    const j = (await res.json()) as { error?: { code?: string; details?: { code?: string } } };
    code = j.error?.details?.code ?? j.error?.code ?? code;
  } catch {
    /* no body */
  }
  return new StoreError(res.status, code);
}

/** A customer bucket, through storage-worker. */
export function remoteStore(worker: StorageFetcher, scope: RemoteScope): MediaStore {
  const url = (key: string, extra: Record<string, string> = {}) =>
    `https://storage.internal/v1/storage/objects?${new URLSearchParams({ orgId: scope.orgId, libraryId: scope.libraryId, backendId: scope.backendId, key: scope.prefix + key, ...extra })}`;
  const call = async (key: string, init: RequestInit, extra: Record<string, string> = {}) => {
    // A streamed body needs duplex "half" (Node insists; workerd accepts it).
    const withDuplex = init.body instanceof ReadableStream ? ({ ...init, duplex: "half" } as RequestInit) : init;
    const res = await worker.fetch(url(key, extra), withDuplex);
    if (!res.ok) throw await errorOf(res);
    return res;
  };
  return {
    async get(key, options) {
      const headers: Record<string, string> = {};
      const r = options?.range;
      if (r) headers.range = `bytes=${r.offset}-${r.offset + r.length - 1}`;
      const res = await worker.fetch(url(key), { headers });
      if (res.status === 404) return null;
      if (!res.ok || !res.body) throw await errorOf(res);
      const total = /\/(\d+)$/.exec(res.headers.get("content-range") ?? "")?.[1];
      const size = Number(total ?? res.headers.get("content-length") ?? 0);
      const body = res.body;
      return { body, size, arrayBuffer: () => new Response(body).arrayBuffer() };
    },
    async put(key, body, options) {
      const extra: Record<string, string> = { contentType: options?.httpMetadata?.contentType ?? "application/octet-stream" };
      if (options?.sha256) extra.sha256 = options.sha256;
      // A checksum refusal reads as one to callers that look for "sha256" (object-store.ts putSingle).
      try {
        return await call(key, { method: "PUT", body: body as BodyInit }, extra);
      } catch (e) {
        if (e instanceof StoreError && e.code === "checksum_mismatch") throw new StoreError(e.status, "sha256_mismatch");
        throw e;
      }
    },
    async delete(key) {
      await call(key, { method: "DELETE" });
    },
    async createMultipartUpload(key, options) {
      const res = await call(key, { method: "POST" }, { op: "createMultipart", contentType: options?.httpMetadata?.contentType ?? "application/octet-stream" });
      return { uploadId: ((await res.json()) as { data: { uploadId: string } }).data.uploadId };
    },
    resumeMultipartUpload(key, uploadId) {
      return {
        async uploadPart(partNumber, body) {
          const res = await call(key, { method: "PUT", body: body as BodyInit }, { op: "uploadPart", uploadId, partNumber: String(partNumber) });
          return ((await res.json()) as { data: UploadedPart }).data;
        },
        async complete(parts) {
          await call(key, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ uploadId, parts }) }, { op: "completeMultipart" });
        },
        async abort() {
          await call(key, { method: "POST" }, { op: "abortMultipart", uploadId });
        },
      };
    },
  };
}
