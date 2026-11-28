// The library browser's folder tree, breadcrumbs and folder-path input, built from the API's flat folder list.

/**
 * The API's flat folder list → nested nodes for el-tree, under one "All files" root (path null).
 * Each node: { path, label, files, children }.
 */
export function buildTree(folders, rootLabel) {
  const root = { path: null, label: rootLabel, files: 0, children: [] };
  const byPath = new Map([["/", root]]);
  const sorted = [...folders].sort((a, b) => a.path.localeCompare(b.path));
  for (const f of sorted) {
    const node = { path: f.path, label: f.name, files: f.files ?? 0, children: [] };
    byPath.set(f.path, node);
    const parent = byPath.get(f.parent ?? "/") ?? root;
    parent.children.push(node);
  }
  return [root];
}

/** "/a/b/c" → [{ path: "/a", label: "a" }, { path: "/a/b", label: "b" }, …] for a breadcrumb. */
export function crumbs(folder) {
  const parts = String(folder || "/").split("/").filter(Boolean);
  return parts.map((label, i) => ({ path: `/${parts.slice(0, i + 1).join("/")}`, label }));
}

/** A folder path someone typed, normalised the way the API does; null when it isn't valid. */
export function normalizeFolderInput(input) {
  const s = String(input ?? "").trim();
  if (!s || s === "/") return "/";
  if (s.length > 1024 || /[\u0000-\u001f]/.test(s)) return null;
  const parts = s.split("/").filter(Boolean);
  if (parts.some((p) => p === "." || p === ".." || p.length > 255)) return null;
  return `/${parts.join("/")}`;
}
