// Derived from MarSeventh/Sanyue-ImgHub@1621525:src/utils/upload/directoryTraversal.js (MIT), modified.
// ImgHub's walk joined each file's relative path onto the upload folder, mapping ".." to "_". Here the walk is bounded
// (files and depth), skips hidden files and folders, drops "." and ".." segments, and returns each file with the
// folder it uploads into: the current folder plus its directory inside what was dropped or picked.

export const MAX_FOLDER_FILES = 2000;
const MAX_DEPTH = 20;

/** "/a" + "b/c" → "/a/b/c"; "/" + "" → "/". */
export function joinFolder(base, rel) {
  const parts = [...String(base || "/").split("/"), ...String(rel || "").split("/")].filter((p) => p && p !== "." && p !== "..");
  return parts.length ? `/${parts.join("/")}` : "/";
}

/** The folder a picked file lands in: the current folder plus its directory in `webkitRelativePath`. */
export function folderForRelativePath(base, relativePath) {
  const dir = String(relativePath || "").split("/").slice(0, -1).join("/");
  return joinFolder(base, dir);
}

const hidden = (name) => name.startsWith(".");

/**
 * Files from a drop that may hold folders (DataTransferItemList), each with the folder it belongs in.
 * Plain files land in `base`. Returns { items: [{ file, folder }], truncated }.
 */
export async function filesFromDrop(items, base, limit = MAX_FOLDER_FILES) {
  const out = [];
  let truncated = false;
  const entries = [];
  const loose = [];
  for (const it of Array.from(items ?? [])) {
    if (it.kind !== "file") continue;
    const entry = typeof it.webkitGetAsEntry === "function" ? it.webkitGetAsEntry() : null;
    if (entry) entries.push(entry);
    else {
      const f = it.getAsFile?.();
      if (f) loose.push(f);
    }
  }
  for (const f of loose) out.push({ file: f, folder: joinFolder(base, "") });

  async function walk(entry, dir, depth) {
    if (out.length >= limit) {
      truncated = true;
      return;
    }
    if (hidden(entry.name)) return;
    if (entry.isFile) {
      const file = await new Promise((res, rej) => entry.file(res, rej));
      out.push({ file, folder: joinFolder(base, dir) });
      return;
    }
    if (!entry.isDirectory || depth > MAX_DEPTH) return;
    const reader = entry.createReader();
    const sub = depth === 0 && !dir ? entry.name : `${dir}/${entry.name}`;
    // readEntries returns at most ~100 entries per call: read until it returns none.
    for (;;) {
      const batch = await new Promise((res, rej) => reader.readEntries(res, rej));
      if (!batch.length) break;
      for (const child of batch) {
        await walk(child, sub, depth + 1);
        if (truncated) return;
      }
    }
  }
  for (const e of entries) {
    await walk(e, "", 0);
    if (truncated) break;
  }
  return { items: out, truncated };
}

