// The media app's only door to the backend: api-edge, with the caller's bearer token. Replaces ImgHub's
// auth-code axios helpers (src/utils/axios.js, fetchWithAuth.js), which talked to a single-admin backend.

const TOKEN_KEY = "pixvault.media.token";
const STAGE_API = "https://pixvault-api-edge-stage.vijayakrishnan12994.workers.dev";

/**
 * The api-edge base URL for this deployment. pixvault-media-web-<env>.<sub>.workers.dev talks to
 * pixvault-api-edge-<env>.<sub>.workers.dev; a local dev server uses VITE_API_BASE or stage.
 */
export function apiBase(hostname = globalThis.location?.hostname ?? "", envBase = import.meta.env?.VITE_API_BASE) {
  if (envBase) return String(envBase).replace(/\/+$/, "");
  const m = /^pixvault-media-web-([a-z0-9]+)\.([a-z0-9-]+\.workers\.dev)$/.exec(hostname);
  if (m) return `https://pixvault-api-edge-${m[1]}.${m[2]}`;
  return STAGE_API;
}

export function getToken(storage = globalThis.localStorage) {
  try {
    return storage?.getItem(TOKEN_KEY) ?? null;
  } catch {
    return null;
  }
}

export function setToken(token, storage = globalThis.localStorage) {
  try {
    if (token) storage?.setItem(TOKEN_KEY, token);
    else storage?.removeItem(TOKEN_KEY);
  } catch {
    /* private mode: the session lasts for this tab only */
  }
}

export class ApiError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details ?? {};
  }
}

const WRITE = new Set(["POST", "PUT", "PATCH", "DELETE"]);

export function createClient({ base = apiBase(), fetchImpl = (...a) => globalThis.fetch(...a), token = () => getToken() } = {}) {
  async function request(method, path, body) {
    const headers = { accept: "application/json" };
    const t = token();
    if (t) headers.authorization = `Bearer ${t}`;
    if (body !== undefined) headers["content-type"] = "application/json";
    if (WRITE.has(method)) headers["idempotency-key"] = globalThis.crypto.randomUUID();
    let res;
    try {
      res = await fetchImpl(`${base}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    } catch {
      throw new ApiError(0, "network", "The service can't be reached. Check your connection and try again.");
    }
    let json = null;
    try {
      json = await res.json();
    } catch {
      json = null;
    }
    if (!res.ok) {
      const e = json?.error ?? {};
      throw new ApiError(res.status, e.code ?? "error", e.message ?? `Request failed (${res.status})`, e.details);
    }
    return json?.data ?? null;
  }

  const lib = (org, id = "") => `/v1/organizations/${encodeURIComponent(org)}/libraries${id ? `/${encodeURIComponent(id)}` : ""}`;

  /** Fetch a file's bytes as a Blob (signed-in download; public links arrive with serving in PV3). */
  async function download(org, id, fileId) {
    const t = token();
    const res = await fetchImpl(`${base}${lib(org, id)}/files/${encodeURIComponent(fileId)}/content`, { headers: t ? { authorization: `Bearer ${t}` } : {} });
    if (!res.ok) throw new ApiError(res.status, "download_failed", `Download failed (${res.status})`);
    return res.blob();
  }

  return {
    base,
    request,
    download,
    auth: {
      loginStart: (email) => request("POST", "/v1/auth/login/start", { email }),
      loginComplete: (challengeId, code) => request("POST", "/v1/auth/login/complete", { challengeId, code }),
      session: () => request("GET", "/v1/auth/session"),
      logout: () => request("POST", "/v1/auth/logout"),
    },
    orgs: {
      list: () => request("GET", "/v1/organizations"),
      create: (name, slug) => request("POST", "/v1/organizations", slug ? { name, slug } : { name }),
      members: (org) => request("GET", `/v1/organizations/${encodeURIComponent(org)}/members`),
    },
    libraries: {
      list: (org) => request("GET", lib(org)),
      create: (org, input) => request("POST", lib(org), input),
      get: (org, id) => request("GET", lib(org, id)),
      update: (org, id, patch) => request("PATCH", lib(org, id), patch),
      archive: (org, id) => request("DELETE", lib(org, id)),
      members: (org, id) => request("GET", `${lib(org, id)}/members`),
      putMember: (org, id, principalId, role) => request("PUT", `${lib(org, id)}/members/${encodeURIComponent(principalId)}`, { role }),
      removeMember: (org, id, principalId) => request("DELETE", `${lib(org, id)}/members/${encodeURIComponent(principalId)}`),
      invite: (org, id, email, role) => request("POST", `${lib(org, id)}/invitations`, { email, role }),
      revokeInvitation: (org, id, invitationId) => request("DELETE", `${lib(org, id)}/invitations/${encodeURIComponent(invitationId)}`),
      guestLibraries: () => request("GET", "/v1/media/libraries"),
      usage: (org) => request("GET", `/v1/organizations/${encodeURIComponent(org)}/media-usage`),
      files: (org, id, { folder, trash, review, cursor, q: text, type, tag, uploader, status, visibility, from, to, limit } = {}) => {
        const q = new URLSearchParams();
        if (folder) q.set("folder", folder);
        if (trash) q.set("trash", "1");
        if (review) q.set("review", "1");
        if (text && String(text).trim()) q.set("q", String(text).trim());
        for (const [k, v] of Object.entries({ type, tag, uploader, status, visibility, from, to, limit })) if (v) q.set(k, String(v));
        if (cursor) q.set("cursor", cursor);
        const qs = q.toString();
        return request("GET", `${lib(org, id)}/files${qs ? `?${qs}` : ""}`);
      },
      trashFile: (org, id, fileId) => request("DELETE", `${lib(org, id)}/files/${encodeURIComponent(fileId)}`),
      restoreFile: (org, id, fileId) => request("POST", `${lib(org, id)}/files/${encodeURIComponent(fileId)}/restore`),
      purgeFile: (org, id, fileId) => request("DELETE", `${lib(org, id)}/files/${encodeURIComponent(fileId)}?permanent=1`),
      setVisibility: (org, id, fileId, visibility) => request("PATCH", `${lib(org, id)}/files/${encodeURIComponent(fileId)}`, { visibility }),
      signedUrl: (org, id, fileId, expiresIn) => request("POST", `${lib(org, id)}/files/${encodeURIComponent(fileId)}/signed-url`, { expiresIn }),
      review: (org, id, fileId, decision) => request("POST", `${lib(org, id)}/files/${encodeURIComponent(fileId)}/review`, { decision }),
      reprocess: (org, id, fileId) => request("POST", `${lib(org, id)}/files/${encodeURIComponent(fileId)}/reprocess`),
      acceptInvitations: () => request("POST", "/v1/media/invitations/accept"),
      // PV5: the library browser
      file: (org, id, fileId) => request("GET", `${lib(org, id)}/files/${encodeURIComponent(fileId)}`),
      moveFile: (org, id, fileId, to) => request("PATCH", `${lib(org, id)}/files/${encodeURIComponent(fileId)}`, to),
      versions: (org, id, fileId) => request("GET", `${lib(org, id)}/files/${encodeURIComponent(fileId)}/versions`),
      restoreVersion: (org, id, fileId, version) => request("POST", `${lib(org, id)}/files/${encodeURIComponent(fileId)}/versions/${Number(version)}/restore`),
      batch: (org, id, body) => request("POST", `${lib(org, id)}/files:batch`, body),
      folders: (org, id) => request("GET", `${lib(org, id)}/folders`),
      createFolder: (org, id, path) => request("POST", `${lib(org, id)}/folders`, { path }),
      moveFolder: (org, id, from, to) => request("POST", `${lib(org, id)}/folders/move`, { from, to }),
      trashFolder: (org, id, path) => request("POST", `${lib(org, id)}/folders/trash`, { path }),
      tags: (org, id) => request("GET", `${lib(org, id)}/tags`),
      liveTicket: (org, id) => request("POST", `${lib(org, id)}/live-tickets`),
      // PV6: sharing
      shareLinks: (org, id, target = {}) => {
        const q = new URLSearchParams();
        for (const k of ["file", "folder", "collection"]) if (target[k]) q.set(k, target[k]);
        const qs = q.toString();
        return request("GET", `${lib(org, id)}/share-links${qs ? `?${qs}` : ""}`);
      },
      createShareLink: (org, id, body) => request("POST", `${lib(org, id)}/share-links`, body),
      revokeShareLink: (org, id, linkId) => request("DELETE", `${lib(org, id)}/share-links/${encodeURIComponent(linkId)}`),
      uploadLinks: (org, id) => request("GET", `${lib(org, id)}/upload-links`),
      createUploadLink: (org, id, body) => request("POST", `${lib(org, id)}/upload-links`, body),
      revokeUploadLink: (org, id, linkId) => request("DELETE", `${lib(org, id)}/upload-links/${encodeURIComponent(linkId)}`),
      collections: (org, id) => request("GET", `${lib(org, id)}/collections`),
      collection: (org, id, colId) => request("GET", `${lib(org, id)}/collections/${encodeURIComponent(colId)}`),
      createCollection: (org, id, body) => request("POST", `${lib(org, id)}/collections`, body),
      updateCollection: (org, id, colId, patch) => request("PATCH", `${lib(org, id)}/collections/${encodeURIComponent(colId)}`, patch),
      deleteCollection: (org, id, colId) => request("DELETE", `${lib(org, id)}/collections/${encodeURIComponent(colId)}`),
      collectionItems: (org, id, colId, action, ids) => request("POST", `${lib(org, id)}/collections/${encodeURIComponent(colId)}/items`, { action, ids }),
      comments: (org, id, fileId) => request("GET", `${lib(org, id)}/files/${encodeURIComponent(fileId)}/comments`),
      addComment: (org, id, fileId, body, mentions = []) => request("POST", `${lib(org, id)}/files/${encodeURIComponent(fileId)}/comments`, { body, mentions }),
      updateComment: (org, id, fileId, commentId, patch) => request("PATCH", `${lib(org, id)}/files/${encodeURIComponent(fileId)}/comments/${encodeURIComponent(commentId)}`, patch),
      deleteComment: (org, id, fileId, commentId) => request("DELETE", `${lib(org, id)}/files/${encodeURIComponent(fileId)}/comments/${encodeURIComponent(commentId)}`),
    },
  };
}

export const api = createClient();
