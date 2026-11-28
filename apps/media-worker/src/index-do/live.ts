// Live updates and presence for one library (PV5), over the Durable Object's hibernating WebSockets (design §1.3,
// "A teammate's live view"). Kept free of Durable Object types so the tests drive it with plain fakes.
//
// An event says only which files changed (ids, folder, status) and never their names or contents. Clients refetch
// through the API, so every read still goes through policy. A socket that may see only its holder's uploads gets
// only events for those. Sockets expire after an hour; the client reconnects with a fresh ticket, which re-checks
// that its holder still belongs to the library.

import type { BatchResult, FileRow, LiveScope } from "./core.js";
import type { IndexOp } from "./library-index.js";
import { filePublicId } from "../ids.js";

export interface Attachment {
  sub: string;
  scope: LiveScope;
  /** The folder the holder is looking at, for presence; null until they say. */
  folder: string | null;
  /** Epoch ms after which the socket is closed (code 4001) so the client re-authorises. */
  exp: number;
}

/** The part of a hibernating WebSocket this module uses. */
export interface LiveSocket {
  send(message: string): void;
  close(code?: number, reason?: string): void;
  deserializeAttachment(): unknown;
  serializeAttachment(value: unknown): void;
}

export interface ChangedFile {
  id: string;
  folder: string;
  status: FileRow["status"];
  /** The uploader's id (used to filter own-scope sockets; not sent). */
  by: string;
}

export interface Change {
  op: string;
  files: ChangedFile[];
  /** The folder tree changed (a folder was made, moved or removed, or a file landed in a new one). */
  tree: boolean;
}

export const SOCKET_TTL_MS = 60 * 60_000;
export const MAX_SOCKETS = 500;
export const EXPIRED_CODE = 4001;

const fileOf = (f: FileRow): ChangedFile => ({ id: filePublicId(f.id), folder: f.folder, status: f.status, by: f.uploaded_by });

/** What a successful index operation changed, for live clients; null for reads and internal steps. */
export function changeFor(req: IndexOp, value: unknown): Change | null {
  switch (req.op) {
    case "commit":
      return { op: "commit", files: [fileOf((value as { file: FileRow }).file)], tree: true };
    case "trash":
    case "restore":
    case "restoreVersion":
    case "setVisibility":
    case "review":
    case "takedown":
    case "reinstate":
    case "reprocess":
      return { op: req.op, files: [fileOf(value as FileRow)], tree: req.op === "restore" };
    case "moveFile":
      return { op: "move", files: [fileOf(value as FileRow)], tree: true };
    case "finishProcessing":
      return value ? { op: "processed", files: [fileOf(value as FileRow)], tree: false } : null;
    case "batch": {
      const done = (value as BatchResult).done;
      return done.length ? { op: `batch.${req.act.action}`, files: done.map(fileOf), tree: req.act.action !== "visibility" } : null;
    }
    case "purge":
      // The row is gone, so the uploader isn't known: only sockets that see every file hear of it.
      return { op: "purge", files: [{ id: filePublicId(req.id), folder: "", status: "trashed", by: "" }], tree: false };
    case "createFolder":
    case "moveFolder":
    case "trashFolder":
      return { op: req.op, files: [], tree: true };
    default:
      return null;
  }
}

export function attachmentOf(ws: LiveSocket): Attachment | null {
  const a = ws.deserializeAttachment() as Attachment | null;
  return a && typeof a.sub === "string" ? a : null;
}

/** Send a change to every socket allowed to see it; close sockets past their lifetime. */
export function deliver(sockets: LiveSocket[], change: Change, now: number): void {
  for (const ws of sockets) {
    const a = attachmentOf(ws);
    if (!a) continue;
    if (now > a.exp) {
      safeClose(ws, EXPIRED_CODE, "expired");
      continue;
    }
    const files = a.scope === "all" ? change.files : change.files.filter((f) => f.by === a.sub);
    if (a.scope === "own" && files.length === 0 && !change.tree) continue;
    safeSend(ws, { t: "change", op: change.op, files: files.map(({ id, folder, status }) => ({ id, folder, status })), tree: change.tree });
  }
}

/** Who is here, one entry per person (the folder they last named). */
export function presenceOf(sockets: LiveSocket[], exclude?: LiveSocket): { t: "presence"; users: { sub: string; folder: string | null }[] } {
  const users = new Map<string, string | null>();
  for (const ws of sockets) {
    if (ws === exclude) continue;
    const a = attachmentOf(ws);
    if (a && (!users.has(a.sub) || a.folder !== null)) users.set(a.sub, a.folder);
  }
  return { t: "presence", users: [...users].map(([sub, folder]) => ({ sub, folder })).sort((x, y) => x.sub.localeCompare(y.sub)) };
}

export function broadcastPresence(sockets: LiveSocket[], exclude?: LiveSocket): void {
  const msg = presenceOf(sockets, exclude);
  for (const ws of sockets) if (ws !== exclude) safeSend(ws, msg);
}

/**
 * A message from a client. The only one is `{"t":"where","folder":"/a/b"}` (presence); anything else is ignored.
 * Returns true when presence changed.
 */
export function onClientMessage(ws: LiveSocket, raw: unknown): boolean {
  if (typeof raw !== "string" || raw.length > 1024) return false;
  let m: { t?: unknown; folder?: unknown };
  try {
    m = JSON.parse(raw) as { t?: unknown; folder?: unknown };
  } catch {
    return false;
  }
  if (!m || m.t !== "where") return false;
  const folder = m.folder === null ? null : typeof m.folder === "string" && /^\/[^\u0000-\u001f]{0,1023}$/.test(m.folder) ? m.folder : undefined;
  if (folder === undefined) return false;
  const a = attachmentOf(ws);
  if (!a || a.folder === folder) return false;
  ws.serializeAttachment({ ...a, folder });
  return true;
}

function safeSend(ws: LiveSocket, msg: unknown): void {
  try {
    ws.send(JSON.stringify(msg));
  } catch {
    /* a socket that is closing: its close handler cleans up */
  }
}

function safeClose(ws: LiveSocket, code: number, reason: string): void {
  try {
    ws.close(code, reason);
  } catch {
    /* already closed */
  }
}
