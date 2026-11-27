// Location data removal (design §4.3, "strip EXIF GPS by default").
//
// JPEG: the GPS IFD inside the EXIF segment is emptied in place (orientation, camera and dates stay); XMP segments
//       that mention GPS are dropped. If the EXIF can't be parsed safely, the whole EXIF segment is dropped.
// PNG:  eXIf chunks and XMP text chunks are dropped.
// WebP: EXIF and XMP chunks are dropped and the VP8X flags cleared.
// Anything else is returned unchanged. Nothing here logs or returns file content.

export type ImageKind = "jpeg" | "png" | "webp" | "gif" | "avif" | "other";

export function sniff(b: Uint8Array): ImageKind {
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "jpeg";
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return "png";
  if (b.length >= 12 && ascii(b, 0, 4) === "RIFF" && ascii(b, 8, 4) === "WEBP") return "webp";
  if (b.length >= 6 && ascii(b, 0, 4) === "GIF8") return "gif";
  if (b.length >= 12 && ascii(b, 4, 4) === "ftyp" && /^avi[fs]$/.test(ascii(b, 8, 4))) return "avif";
  return "other";
}

export interface StripResult {
  bytes: Uint8Array;
  changed: boolean;
  /** What was removed, e.g. ["exif.gps"], for the file's pipeline note. */
  removed: string[];
}

function ascii(b: Uint8Array, at: number, n: number): string {
  let s = "";
  for (let i = at; i < at + n && i < b.length; i++) s += String.fromCharCode(b[i]!);
  return s;
}

function concat(parts: Uint8Array[]): Uint8Array {
  const n = parts.reduce((a, p) => a + p.length, 0);
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

const TYPE_SIZE: Record<number, number> = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 6: 1, 7: 1, 8: 2, 9: 4, 10: 8, 11: 4, 12: 8 };

/**
 * Empty the GPS IFD of a TIFF structure that starts at `t` inside `seg` (modified in place). Returns true if GPS
 * entries were removed, false if there were none; throws if the structure is malformed.
 */
export function emptyGpsIfd(seg: Uint8Array, t: number): boolean {
  const end = seg.length;
  const need = (at: number, n: number) => {
    if (at < 0 || at + n > end) throw new Error("exif out of bounds");
  };
  need(t, 8);
  const order = ascii(seg, t, 2);
  if (order !== "II" && order !== "MM") throw new Error("bad byte order");
  const le = order === "II";
  const dv = new DataView(seg.buffer, seg.byteOffset, seg.byteLength);
  const u16 = (at: number) => (need(at, 2), dv.getUint16(at, le));
  const u32 = (at: number) => (need(at, 4), dv.getUint32(at, le));
  const ifd0 = t + u32(t + 4);
  const n0 = u16(ifd0);
  if (n0 > 1000) throw new Error("ifd too large");
  let gps = -1;
  for (let k = 0; k < n0; k++) {
    const e = ifd0 + 2 + 12 * k;
    if (u16(e) === 0x8825) gps = t + u32(e + 8);
  }
  if (gps < 0) return false;
  const m = u16(gps);
  if (m > 1000) throw new Error("gps ifd too large");
  need(gps, 2 + 12 * m);
  for (let k = 0; k < m; k++) {
    const e = gps + 2 + 12 * k;
    const size = (TYPE_SIZE[u16(e + 2)] ?? 1) * u32(e + 4);
    if (size > 4) {
      const off = t + u32(e + 8);
      need(off, size);
      seg.fill(0, off, off + size);
    }
    seg.fill(0, e, e + 12);
  }
  // An IFD with no entries: readers see no GPS tags (the next-IFD pointer is now zero too).
  dv.setUint16(gps, 0, le);
  return m > 0;
}

function stripJpeg(b: Uint8Array): StripResult {
  const parts: Uint8Array[] = [b.subarray(0, 2)];
  const removed: string[] = [];
  let i = 2;
  while (i + 1 < b.length) {
    if (b[i] !== 0xff) break; // not a marker: keep the rest as it is
    let j = i;
    while (j + 1 < b.length && b[j + 1] === 0xff) j++; // fill bytes
    const marker = b[j + 1]!;
    if (marker === 0xda || marker === 0xd9) break; // start of scan / end: the rest is image data
    if ((marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) {
      parts.push(b.subarray(i, j + 2));
      i = j + 2;
      continue;
    }
    if (j + 3 >= b.length) break;
    const len = (b[j + 2]! << 8) | b[j + 3]!;
    const segEnd = j + 2 + len;
    if (len < 2 || segEnd > b.length) break;
    let seg = b.subarray(i, segEnd);
    if (marker === 0xe1) {
      const body = j + 4;
      if (ascii(b, body, 6) === "Exif\0\0") {
        const copy = seg.slice();
        try {
          if (emptyGpsIfd(copy, body - i + 6)) removed.push("exif.gps");
          seg = copy;
        } catch {
          removed.push("exif.unreadable");
          i = segEnd;
          continue; // drop the whole EXIF segment rather than keep what we can't read
        }
      } else if (ascii(b, body, 29) === "http://ns.adobe.com/xap/1.0/\0" && ascii(b, body, segEnd - body).includes("GPS")) {
        removed.push("xmp.gps");
        i = segEnd;
        continue;
      }
    }
    parts.push(seg);
    i = segEnd;
  }
  parts.push(b.subarray(i));
  return removed.length ? { bytes: concat(parts), changed: true, removed } : { bytes: b, changed: false, removed };
}

function stripPng(b: Uint8Array): StripResult {
  const parts: Uint8Array[] = [b.subarray(0, 8)];
  const removed: string[] = [];
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  let i = 8;
  while (i + 12 <= b.length) {
    const len = dv.getUint32(i);
    const type = ascii(b, i + 4, 4);
    const end = i + 12 + len;
    if (end > b.length) break;
    const isXmp = (type === "iTXt" || type === "tEXt" || type === "zTXt") && ascii(b, i + 8, 18) === "XML:com.adobe.xmp\0";
    if (type === "eXIf" || isXmp) removed.push(type === "eXIf" ? "png.exif" : "png.xmp");
    else parts.push(b.subarray(i, end));
    i = end;
    if (type === "IEND") break;
  }
  if (i < b.length) parts.push(b.subarray(i));
  return removed.length ? { bytes: concat(parts), changed: true, removed } : { bytes: b, changed: false, removed };
}

function stripWebp(b: Uint8Array): StripResult {
  const removed: string[] = [];
  const parts: Uint8Array[] = [];
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  let i = 12;
  let vp8x: Uint8Array | null = null;
  while (i + 8 <= b.length) {
    const fourcc = ascii(b, i, 4);
    const size = dv.getUint32(i + 4, true);
    const end = i + 8 + size + (size & 1);
    if (end > b.length) {
      parts.push(b.subarray(i));
      i = b.length;
      break;
    }
    if (fourcc === "EXIF" || fourcc === "XMP ") {
      removed.push(fourcc === "EXIF" ? "webp.exif" : "webp.xmp");
    } else {
      const chunk = fourcc === "VP8X" ? b.slice(i, end) : b.subarray(i, end);
      if (fourcc === "VP8X") vp8x = chunk;
      parts.push(chunk);
    }
    i = end;
  }
  if (!removed.length) return { bytes: b, changed: false, removed };
  if (vp8x && vp8x.length > 8) vp8x[8] = vp8x[8]! & ~0x0c; // clear the EXIF (0x08) and XMP (0x04) flags
  const body = concat(parts);
  const head = b.slice(0, 12);
  new DataView(head.buffer).setUint32(4, body.length + 4, true);
  return { bytes: concat([head, body]), changed: true, removed };
}

/** Remove location metadata from an image. Unknown formats come back unchanged. */
export function stripLocation(bytes: Uint8Array): StripResult {
  switch (sniff(bytes)) {
    case "jpeg":
      return stripJpeg(bytes);
    case "png":
      return stripPng(bytes);
    case "webp":
      return stripWebp(bytes);
    default:
      return { bytes, changed: false, removed: [] };
  }
}

/** Does this JPEG still carry GPS entries? (For tests and the stage check.) */
export function jpegHasGps(b: Uint8Array): boolean {
  let i = 2;
  while (i + 4 < b.length && b[i] === 0xff) {
    const marker = b[i + 1]!;
    if (marker === 0xda || marker === 0xd9) return false;
    const len = (b[i + 2]! << 8) | b[i + 3]!;
    if (marker === 0xe1 && ascii(b, i + 4, 6) === "Exif\0\0") {
      const copy = b.slice(i, i + 2 + len);
      try {
        return emptyGpsIfd(copy, 10);
      } catch {
        return true;
      }
    }
    i += 2 + len;
  }
  return false;
}
