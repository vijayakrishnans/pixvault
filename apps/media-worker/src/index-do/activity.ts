// What each index write means for the activity log (PV6): one entry per file it touched, or one for a folder or
// collection. Entries say who (the caller's id, an upload link, the pipeline or "operator"), what, which file and a
// small detail (names, folders, states). Never file contents, comment words, IP addresses or link tokens.

import type { ActivityInput, BatchResult, CollectionRow, CommentRow, CommitResult, FileRow } from "./core.js";
import type { IndexOp } from "./library-index.js";

const one = (op: string, f: FileRow, detail: ActivityInput["detail"] = {}): ActivityInput => ({ op, fileId: f.id, folder: f.folder, detail: { name: f.name, ...detail } });

export function activityFor(req: IndexOp, value: unknown): ActivityInput[] {
  switch (req.op) {
    case "commit": {
      const r = value as CommitResult;
      return [one(r.file.version > 1 ? "file.version" : "file.uploaded", r.file, { version: r.file.version, size: r.file.size })];
    }
    case "moveFile":
      return [one("file.moved", value as FileRow, { to: (value as FileRow).path })];
    case "trash":
      return [one("file.trashed", value as FileRow)];
    case "restore":
      return [one("file.restored", value as FileRow)];
    case "purge":
      return [{ op: "file.purged", fileId: req.id }];
    case "restoreVersion":
      return [one("file.version_restored", value as FileRow, { version: req.version })];
    case "setVisibility":
      return [one("file.visibility", value as FileRow, { visibility: req.visibility })];
    case "review":
      return [one(req.decision === "approve" ? "file.approved" : "file.rejected", value as FileRow)];
    case "takedown":
      return [one("file.taken_down", value as FileRow)];
    case "reinstate":
      return [one("file.reinstated", value as FileRow)];
    case "finishProcessing":
      return value ? [one("file.processed", value as FileRow, { status: (value as FileRow).status })] : [];
    case "batch": {
      const done = (value as BatchResult).done;
      const op = { move: "file.moved", trash: "file.trashed", restore: "file.restored", visibility: "file.visibility" }[req.act.action];
      const detail = req.act.action === "move" ? { to: req.act.folder } : req.act.action === "visibility" ? { visibility: req.act.visibility } : {};
      return done.map((f) => one(op, f, { ...detail, batch: true }));
    }
    case "createFolder":
      return [{ op: "folder.created", folder: req.folder }];
    case "moveFolder":
      return [{ op: "folder.moved", folder: req.to, detail: { from: req.from } }];
    case "trashFolder":
      return [{ op: "folder.trashed", folder: req.folder, detail: { files: (value as { trashed: number }).trashed } }];
    case "createCollection":
      return [{ op: "collection.created", detail: { collection: (value as CollectionRow).name } }];
    case "deleteCollection":
      return [{ op: "collection.deleted" }];
    case "collectionItems": {
      const r = value as { collection: CollectionRow; changed: number };
      return r.changed ? [{ op: req.action === "add" ? "collection.files_added" : "collection.files_removed", detail: { collection: r.collection.name, files: r.changed } }] : [];
    }
    case "addComment": {
      const c = value as CommentRow;
      return [{ op: "file.commented", fileId: c.file_id }];
    }
    default:
      return [];
  }
}
