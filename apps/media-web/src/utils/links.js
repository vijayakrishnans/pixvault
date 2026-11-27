// Derived from MarSeventh/Sanyue-ImgHub@1621525:src/utils/upload/urlBuilder.js (MIT), modified.
// The same four formats (URL, Markdown, HTML, BBCode). Here the file name is escaped for each format (upstream put it
// into HTML and Markdown raw), and non-images become links instead of embedded images.

export const LINK_FORMATS = ["url", "markdown", "html", "bbcode"];

const isImage = (mime) => /^image\//i.test(mime ?? "");

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

function escapeMarkdown(s) {
  return String(s).replace(/[\\[\]()*_`!<>]/g, (c) => `\\${c}`);
}

/** BBCode has no escaping: drop the characters that would end a tag. */
function bbText(s) {
  return String(s).replace(/[[\]]/g, "");
}

/** Every format for one URL. `url` must already be a valid absolute URL (the API builds it). */
export function buildLinks(url, name, mime) {
  const img = isImage(mime);
  const u = String(url);
  // A URL from the API never contains these, but a snippet must stay one token whatever it is given.
  const mdUrl = u.replace(/[()\s<>]/g, encodeURIComponent);
  return {
    url: u,
    markdown: img ? `![${escapeMarkdown(name)}](${mdUrl})` : `[${escapeMarkdown(name)}](${mdUrl})`,
    html: img ? `<img src="${escapeHtml(u)}" alt="${escapeHtml(name)}" loading="lazy" />` : `<a href="${escapeHtml(u)}">${escapeHtml(name)}</a>`,
    bbcode: img ? `[img]${bbText(u)}[/img]` : `[url=${bbText(u)}]${bbText(name)}[/url]`,
  };
}

/** Signed-link lifetimes the app offers, in seconds (the API accepts 60 s to 7 days). */
export const SIGNED_TTLS = [
  { key: "hour", seconds: 3600 },
  { key: "day", seconds: 86400 },
  { key: "week", seconds: 604800 },
];
