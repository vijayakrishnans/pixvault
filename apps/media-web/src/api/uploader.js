// Upload one file into a library: hash it, open (or resume) a session, send the missing parts with progress,
// commit. A session survives a reload: it's remembered under the file's name, size and modification time, and
// the server says which parts it already holds.
//
// Replaces ImgHub's single-request and chunked upload flows (src/components/upload/UploadForm.vue), which posted
// to an upstream channel; see the port inventory.

import { api as defaultApi, apiBase, getToken, ApiError } from "./client.js";
import { computeSha256 } from "../utils/upload/sha256.js";

const RESUME_PREFIX = "pixvault.media.upload.";
const PART_RETRIES = 3;

/** The same file dropped into two folders is two uploads, so the folder is part of the key. */
export function resumeKey(libraryId, file, folder = "/") {
  return `${RESUME_PREFIX}${libraryId}.${file.size}.${file.lastModified}.${folder === "/" ? "" : `${folder}/`}${file.name}`;
}

function readResume(storage, key) {
  try {
    return JSON.parse(storage?.getItem(key) ?? "null");
  } catch {
    return null;
  }
}
function writeResume(storage, key, value) {
  try {
    if (value) storage?.setItem(key, JSON.stringify(value));
    else storage?.removeItem(key);
  } catch {
    /* resume won't survive a reload; the upload still works */
  }
}

/** PUT one part with upload progress (XHR: fetch can't report upload progress). */
export function xhrPutPart(url, blob, onProgress, signal) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", url);
    const t = getToken();
    if (t) xhr.setRequestHeader("authorization", `Bearer ${t}`);
    xhr.setRequestHeader("idempotency-key", crypto.randomUUID());
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress?.(e.loaded);
    xhr.onload = () => {
      let json = null;
      try {
        json = JSON.parse(xhr.responseText);
      } catch {
        /* not JSON */
      }
      resolve({ status: xhr.status, json });
    };
    xhr.onerror = () => reject(new ApiError(0, "network", "The connection dropped while sending a part."));
    xhr.onabort = () => reject(new DOMException("Upload aborted", "AbortError"));
    signal?.addEventListener("abort", () => xhr.abort(), { once: true });
    xhr.send(blob);
  });
}

/**
 * @param {object} o
 * @param {string} o.org  org_… id
 * @param {string} o.lib  lib_… id
 * @param {File} o.file
 * @param {string} [o.folder]
 * @param {"public"|"private"} [o.visibility]
 * @param {boolean} [o.replace]
 * @param {(s: {phase: string, progress?: number}) => void} [o.onStatus]
 * @param {AbortSignal} [o.signal]
 * @param {object} [deps] injectable for tests: { api, putPart, storage, sha256, sleep }
 * @returns {Promise<{file: object, deduplicated: boolean, resumed: boolean}>}
 */
export async function uploadFile(o, deps = {}) {
  const api = deps.api ?? defaultApi;
  const putPart = deps.putPart ?? xhrPutPart;
  const storage = deps.storage ?? globalThis.localStorage;
  const sha256 = deps.sha256 ?? computeSha256;
  const sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  const status = o.onStatus ?? (() => {});
  const base = `/v1/organizations/${encodeURIComponent(o.org)}/libraries/${encodeURIComponent(o.lib)}`;

  status({ phase: "hashing", progress: 0 });
  const sha = await sha256(o.file, (p) => status({ phase: "hashing", progress: p }), o.signal);

  const key = resumeKey(o.lib, o.file, o.folder ?? "/");
  let session = null;
  let resumed = false;
  const saved = readResume(storage, key);
  if (saved?.sha256 === sha && saved.sessionId) {
    try {
      const r = await api.request("GET", `${base}/uploads/${encodeURIComponent(saved.sessionId)}`);
      if (r?.session) {
        session = r.session;
        resumed = true;
      }
    } catch {
      writeResume(storage, key, null); // expired or gone: start over
    }
  }

  if (!session) {
    status({ phase: "starting" });
    const created = await api.request("POST", `${base}/uploads`, {
      name: o.file.name,
      folder: o.folder || "/",
      size: o.file.size,
      sha256: sha,
      mime: o.file.type || "application/octet-stream",
      ...(o.visibility ? { visibility: o.visibility } : {}),
      ...(o.replace ? { replace: true } : {}),
    });
    if (created?.file) {
      status({ phase: "done", progress: 1 });
      return { file: created.file, deduplicated: true, resumed: false };
    }
    session = created.session;
    writeResume(storage, key, { sessionId: session.id, sha256: sha });
  }

  const done = new Set(session.uploadedParts);
  let sent = [...done].reduce((n, p) => n + partLength(session, p), 0);
  status({ phase: "uploading", progress: sent / Math.max(1, session.size) });
  for (let n = 1; n <= session.partCount; n++) {
    if (done.has(n)) continue;
    const start = (n - 1) * session.partSize;
    const blob = o.file.slice(start, start + partLength(session, n));
    for (let attempt = 1; ; attempt++) {
      if (o.signal?.aborted) throw new DOMException("Upload aborted", "AbortError");
      try {
        const r = await putPart(`${apiBase()}${base}/uploads/${encodeURIComponent(session.id)}/parts/${n}`, blob, (loaded) => status({ phase: "uploading", progress: (sent + loaded) / session.size }), o.signal);
        if (r.status === 200) break;
        const e = r.json?.error ?? {};
        // Client errors won't fix themselves on retry.
        if (r.status >= 400 && r.status < 500 && r.status !== 429) throw new ApiError(r.status, e.code ?? "error", e.message ?? `Part ${n} was refused`);
        throw new ApiError(r.status, e.code ?? "retry", e.message ?? `Part ${n} failed`);
      } catch (err) {
        if (err?.name === "AbortError" || (err instanceof ApiError && err.status >= 400 && err.status < 500 && err.status !== 429) || attempt >= PART_RETRIES) throw err;
        await sleep(500 * 2 ** (attempt - 1));
      }
    }
    sent += partLength(session, n);
  }

  status({ phase: "verifying" });
  const committed = await api.request("POST", `${base}/uploads/${encodeURIComponent(session.id)}/commit`);
  writeResume(storage, key, null);
  status({ phase: "done", progress: 1 });
  return { file: committed.file, deduplicated: committed.deduplicated, resumed };
}

function partLength(session, n) {
  return n < session.partCount ? session.partSize : session.size - session.partSize * (session.partCount - 1);
}
