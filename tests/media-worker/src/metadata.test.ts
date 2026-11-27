// PV-22: location data removal. Synthetic bytes only.
import { randomBytes } from "node:crypto";
import { emptyGpsIfd, jpegHasGps, sniff, stripLocation } from "@media-worker/pipeline/metadata";
import { exifTiffWithGps, jpegWithGps, pngWithExif, webpWithExif } from "./fixtures.js";

const has = (b: Uint8Array, text: string) => Buffer.from(b).includes(Buffer.from(text));
const tiffOrientation = (tiff: Uint8Array) => new DataView(tiff.buffer, tiff.byteOffset).getUint16(8 + 2 + 8, true);

describe("JPEG", () => {
  it("empties the GPS IFD, keeps orientation and the image data, drops XMP that mentions GPS", () => {
    const src = jpegWithGps();
    expect(jpegHasGps(src)).toBe(true);
    const r = stripLocation(src);
    expect(r.changed).toBe(true);
    expect(r.removed).toEqual(["exif.gps", "xmp.gps"]);
    expect(jpegHasGps(r.bytes)).toBe(false);
    expect(has(r.bytes, "GPSLatitude")).toBe(false);
    expect(has(r.bytes, "N\0")).toBe(false);
    // The latitude rational 12/1 is gone (it was the only "\x0c\0\0\0\x01\0\0\0" run).
    expect(Buffer.from(r.bytes).includes(Buffer.from([12, 0, 0, 0, 1, 0, 0, 0]))).toBe(false);
    // Orientation survives: the EXIF segment starts right after SOI.
    const tiff = r.bytes.subarray(2 + 4 + 6);
    expect(tiffOrientation(tiff)).toBe(6);
    // Everything from the start of scan is byte-for-byte the same.
    const sos = (b: Uint8Array) => Buffer.from(b).indexOf(Buffer.from([0xff, 0xda]));
    expect(Buffer.from(r.bytes.subarray(sos(r.bytes))).equals(Buffer.from(src.subarray(sos(src))))).toBe(true);
  });

  it("leaves a JPEG without location data untouched", () => {
    const once = stripLocation(jpegWithGps()).bytes;
    const twice = stripLocation(once);
    expect(twice.changed).toBe(false);
    expect(twice.bytes).toBe(once);
  });

  it("drops an EXIF segment it can't read rather than keep it", () => {
    const src = jpegWithGps({ xmp: false });
    const broken = src.slice();
    // Point IFD0 far outside the segment.
    new DataView(broken.buffer).setUint32(2 + 4 + 6 + 4, 0xfffff, true);
    const r = stripLocation(broken);
    expect(r.removed).toEqual(["exif.unreadable"]);
    expect(has(r.bytes, "Exif\0\0")).toBe(false);
  });

  it("never throws on arbitrary bytes behind a JPEG signature", () => {
    for (let i = 0; i < 300; i++) {
      const junk = new Uint8Array(randomBytes(1 + (i % 200)));
      junk.set([0xff, 0xd8, 0xff, 0xe1].slice(0, Math.min(4, junk.length)));
      expect(() => stripLocation(junk)).not.toThrow();
    }
  });

  it("emptyGpsIfd reports false when there is no GPS pointer", () => {
    const t = exifTiffWithGps().slice();
    new DataView(t.buffer).setUint16(8 + 2 + 12, 0x9999, true); // rename the GPSInfo tag
    expect(emptyGpsIfd(t, 0)).toBe(false);
  });
});

describe("PNG and WebP", () => {
  it("PNG: drops eXIf and XMP chunks, keeps the rest", () => {
    const r = stripLocation(pngWithExif());
    expect(r.removed).toEqual(["png.exif", "png.xmp"]);
    expect(has(r.bytes, "eXIf")).toBe(false);
    expect(has(r.bytes, "XML:com.adobe.xmp")).toBe(false);
    for (const c of ["IHDR", "IDAT", "IEND"]) expect(has(r.bytes, c)).toBe(true);
  });

  it("WebP: drops EXIF and XMP, clears their VP8X flags and fixes the RIFF size", () => {
    const r = stripLocation(webpWithExif());
    expect(r.removed).toEqual(["webp.exif", "webp.xmp"]);
    expect(has(r.bytes, "EXIF")).toBe(false);
    expect(has(r.bytes, "XMP ")).toBe(false);
    const dv = new DataView(r.bytes.buffer, r.bytes.byteOffset);
    expect(dv.getUint32(4, true)).toBe(r.bytes.length - 8);
    const vp8x = Buffer.from(r.bytes).indexOf(Buffer.from("VP8X"));
    expect(r.bytes[vp8x + 8]! & 0x0c).toBe(0);
    expect(r.bytes[vp8x + 8]! & 0x10).toBe(0x10); // other flags untouched
  });

  it("other formats come back unchanged", () => {
    const pdf = new TextEncoder().encode("%PDF-1.7 GPS 12,34");
    expect(sniff(pdf)).toBe("other");
    expect(stripLocation(pdf)).toEqual({ bytes: pdf, changed: false, removed: [] });
  });
});
