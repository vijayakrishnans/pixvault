// Small pure helpers for the library browser: file kinds, thumbnails, and which live changes touch the view.

const DOCUMENT = /^(application\/pdf|text\/|application\/msword|application\/vnd\.|application\/rtf)/i;

/** The kind the browser groups a MIME type under (the same split as the API's `type` filter). */
export function fileKind(mime) {
  const m = String(mime ?? "");
  if (/^image\//i.test(m)) return "image";
  if (/^video\//i.test(m)) return "video";
  if (/^audio\//i.test(m)) return "audio";
  if (DOCUMENT.test(m)) return "document";
  return "other";
}

/** A thumbnail URL for a served public image (serving's thumb preset), or null. */
export function thumbUrl(file, preset = "thumb") {
  if (!file?.url || file.status !== "public" || fileKind(file.mime) !== "image") return null;
  try {
    const u = new URL(file.url);
    u.searchParams.set("preset", preset);
    return u.toString();
  } catch {
    return null;
  }
}

/** A signed URL with a preset (for a private image's preview), or the URL unchanged when it can't be parsed. */
export function withPreset(url, preset) {
  try {
    const u = new URL(url);
    u.searchParams.set("preset", preset);
    return u.toString();
  } catch {
    return url;
  }
}

/**
 * Should a live change reload what's on screen? Yes if it touches a listed file, lands in the folder in view,
 * or the view isn't one folder (search, filters, "All files").
 */
export function changeTouchesView(change, { folder, listedIds, filtered }) {
  if (!change) return false;
  if (filtered || folder == null) return change.files.length > 0 || change.tree;
  if (change.files.some((f) => listedIds.has(f.id) || f.folder === folder)) return true;
  // Folder moves and deletes can empty or fill the folder in view.
  return change.files.length === 0 && change.tree;
}

/** Initials for a presence avatar from an email or id. */
export function initials(label) {
  const s = String(label ?? "").split("@")[0].replace(/^usr_/, "");
  const parts = s.split(/[._\-\s]+/).filter(Boolean);
  return ((parts[0]?.[0] ?? "?") + (parts[1]?.[0] ?? "")).toUpperCase();
}
