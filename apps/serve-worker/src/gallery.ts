// Derived from MarSeventh/Sanyue-ImgHub@1621525:src/views/PublicBrowse.vue (MIT), modified.
// ImgHub's public browse page was a Vue app listing a whole directory. Here a gallery is one collection a team
// marked public, rendered on the server with no script: a grid of its files that are already public, each a
// thumbnail (serving's thumb preset) linking to the file. Private, processing, held and taken-down files never
// appear. It is off while public sharing is off.

import { esc, page } from "./report.js";

export const GALLERY_RE = /^\/_gallery\/([0-9a-f]{32})$/;
const CSP = "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'";

export interface GalleryView {
  collection: { name: string; description: string };
  files: { path: string; name: string; mime: string; width: number | null; height: number | null }[];
}

export function hexToUuid(h: string): string {
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

const href = (org: string, lib: string, path: string) => `/${org}/${lib}${path.split("/").map(encodeURIComponent).join("/")}`;

export function galleryPage(org: string, lib: string, v: GalleryView): Response {
  const items = v.files
    .map((f) => {
      const url = href(org, lib, f.path);
      const img = /^image\//i.test(f.mime)
        ? `<img src="${esc(url)}?preset=thumb" alt="${esc(f.name)}" loading="lazy"${f.width && f.height ? ` width="${f.width}" height="${f.height}"` : ""}>`
        : `<span class="file">${esc(f.name)}</span>`;
      return `<li><a href="${esc(url)}">${img}</a></li>`;
    })
    .join("");
  const body = `<style>body{max-width:1100px}.grid{list-style:none;padding:0;display:grid;grid-template-columns:repeat(auto-fill,minmax(160px,1fr));gap:10px}.grid img{width:100%;height:160px;object-fit:cover;border-radius:8px;display:block}.file{display:grid;place-items:center;height:160px;border:1px solid #ccc;border-radius:8px;padding:8px;word-break:break-all;font-size:14px}</style>
<h1>${esc(v.collection.name)}</h1>${v.collection.description ? `<p>${esc(v.collection.description)}</p>` : ""}<p class="muted">${v.files.length} file${v.files.length === 1 ? "" : "s"}</p>
${v.files.length ? `<ul class="grid">${items}</ul>` : "<p>Nothing here yet.</p>"}<p class="muted">A public gallery on Pixvault. Something wrong with a file? Open it and use its report link.</p>`;
  return page(200, v.collection.name, body, { "content-security-policy": CSP, "cache-control": "public, max-age=60", "referrer-policy": "strict-origin-when-cross-origin" });
}
