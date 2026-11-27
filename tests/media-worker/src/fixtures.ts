// Synthetic image bytes for pipeline tests. No real photo: every byte is built here, with a made-up location.

const enc = new TextEncoder();
const cat = (...parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
};
const u16be = (n: number) => new Uint8Array([(n >> 8) & 255, n & 255]);

/** A little-endian TIFF block: IFD0 {Orientation=6, GPSInfo→GPS IFD}, GPS IFD {LatRef "N", Lat, Long}. */
export function exifTiffWithGps(): Uint8Array {
  const b = new Uint8Array(8 + 2 + 2 * 12 + 4 + 2 + 3 * 12 + 4 + 48);
  const dv = new DataView(b.buffer);
  b.set(enc.encode("II"), 0);
  dv.setUint16(2, 42, true);
  dv.setUint32(4, 8, true);
  let o = 8;
  dv.setUint16(o, 2, true);
  o += 2;
  // Orientation SHORT 1 = 6
  dv.setUint16(o, 0x0112, true); dv.setUint16(o + 2, 3, true); dv.setUint32(o + 4, 1, true); dv.setUint16(o + 8, 6, true);
  o += 12;
  const gpsIfd = 8 + 2 + 24 + 4;
  dv.setUint16(o, 0x8825, true); dv.setUint16(o + 2, 4, true); dv.setUint32(o + 4, 1, true); dv.setUint32(o + 8, gpsIfd, true);
  o += 12;
  dv.setUint32(o, 0, true);
  o = gpsIfd;
  dv.setUint16(o, 3, true);
  o += 2;
  const data = gpsIfd + 2 + 36 + 4;
  dv.setUint16(o, 0x0001, true); dv.setUint16(o + 2, 2, true); dv.setUint32(o + 4, 2, true); b.set(enc.encode("N\0"), o + 8);
  o += 12;
  dv.setUint16(o, 0x0002, true); dv.setUint16(o + 2, 5, true); dv.setUint32(o + 4, 3, true); dv.setUint32(o + 8, data, true);
  o += 12;
  dv.setUint16(o, 0x0004, true); dv.setUint16(o + 2, 5, true); dv.setUint32(o + 4, 3, true); dv.setUint32(o + 8, data + 24, true);
  o += 12;
  dv.setUint32(o, 0, true);
  // 12°34'56" N, 98°7'6" E as rationals
  const vals = [12, 1, 34, 1, 56, 1, 98, 1, 7, 1, 6, 1];
  vals.forEach((v, i) => dv.setUint32(data + 4 * i, v, true));
  return b;
}

/** A JPEG-shaped byte string: SOI, EXIF (with GPS), XMP (with GPS), a dummy segment, SOS, scan bytes, EOI. */
export function jpegWithGps(opts: { xmp?: boolean; scan?: Uint8Array } = {}): Uint8Array {
  const exifBody = cat(enc.encode("Exif\0\0"), exifTiffWithGps());
  const app1 = cat(new Uint8Array([0xff, 0xe1]), u16be(exifBody.length + 2), exifBody);
  const xmpBody = cat(enc.encode("http://ns.adobe.com/xap/1.0/\0"), enc.encode('<x:xmpmeta><rdf:Description exif:GPSLatitude="12,34.9N"/></x:xmpmeta>'));
  const xmp = opts.xmp === false ? new Uint8Array(0) : cat(new Uint8Array([0xff, 0xe1]), u16be(xmpBody.length + 2), xmpBody);
  const dqt = cat(new Uint8Array([0xff, 0xdb]), u16be(4), new Uint8Array([0, 1]));
  const sos = cat(new Uint8Array([0xff, 0xda]), u16be(4), new Uint8Array([1, 0]));
  const scan = opts.scan ?? new Uint8Array([0x12, 0x34, 0xff, 0x00, 0x56]);
  return cat(new Uint8Array([0xff, 0xd8]), app1, xmp, dqt, sos, scan, new Uint8Array([0xff, 0xd9]));
}

function pngChunk(type: string, data: Uint8Array): Uint8Array {
  const len = new Uint8Array(4);
  new DataView(len.buffer).setUint32(0, data.length);
  return cat(len, enc.encode(type), data, new Uint8Array(4)); // CRC isn't checked by the stripper
}

export function pngWithExif(): Uint8Array {
  return cat(
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", new Uint8Array(13)),
    pngChunk("eXIf", exifTiffWithGps()),
    pngChunk("iTXt", cat(enc.encode("XML:com.adobe.xmp\0"), enc.encode("\0\0\0\0GPS"))),
    pngChunk("IDAT", new Uint8Array([1, 2, 3])),
    pngChunk("IEND", new Uint8Array(0)),
  );
}

function riffChunk(fourcc: string, data: Uint8Array): Uint8Array {
  const size = new Uint8Array(4);
  new DataView(size.buffer).setUint32(0, data.length, true);
  return cat(enc.encode(fourcc), size, data, data.length & 1 ? new Uint8Array(1) : new Uint8Array(0));
}

export function webpWithExif(): Uint8Array {
  const vp8x = new Uint8Array(10);
  vp8x[0] = 0x08 | 0x04 | 0x10; // EXIF, XMP, alpha
  const body = cat(enc.encode("WEBP"), riffChunk("VP8X", vp8x), riffChunk("VP8L", new Uint8Array([1, 2, 3, 4, 5])), riffChunk("EXIF", exifTiffWithGps()), riffChunk("XMP ", enc.encode("<x>GPS</x>")));
  const head = cat(enc.encode("RIFF"), new Uint8Array(4));
  new DataView(head.buffer).setUint32(4, body.length, true);
  return cat(head, body);
}
