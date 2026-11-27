// Derived from MarSeventh/CloudFlare-ImgBed@611153e:functions/file/imageTransform.js (MIT), modified.
// ImgBed accepts any width/height up to 4096. Here only the library's presets are accepted, so a public URL can't
// be used to mint unbounded unique variants (risk PV-B); the transform itself is the same Images-binding call.

import type { Env } from "./env.js";

export interface PresetOptions {
  width: number;
  height?: number;
  fit: "cover" | "scale-down";
}

const PRESETS: Record<string, PresetOptions> = {
  thumb: { width: 200, height: 200, fit: "cover" },
  small: { width: 480, fit: "scale-down" },
  medium: { width: 960, fit: "scale-down" },
  large: { width: 1920, fit: "scale-down" },
};

export function presetOptions(name: string): PresetOptions | null {
  return Object.prototype.hasOwnProperty.call(PRESETS, name) ? PRESETS[name]! : null;
}

/** AVIF if the client takes it, then WebP, else the source's own format (JPEG for anything else). */
export function negotiateFormat(accept: string | null, sourceType: string): string {
  const a = (accept ?? "").toLowerCase();
  if (a.includes("image/avif")) return "image/avif";
  if (a.includes("image/webp")) return "image/webp";
  return /^image\/(png|gif)$/i.test(sourceType) ? sourceType.toLowerCase() : "image/jpeg";
}

export async function transformImage(env: Env, input: ReadableStream, opts: PresetOptions, format: string, sourceType: string): Promise<Response | null> {
  if (!env.IMAGES || typeof env.IMAGES.input !== "function") return null;
  try {
    const out = await env.IMAGES.input(input)
      .transform(opts)
      .output({ format: format as "image/avif" | "image/webp" | "image/jpeg" | "image/png" | "image/gif", ...(sourceType === "image/gif" ? { anim: true } : {}) });
    return out.response();
  } catch (e) {
    console.error(JSON.stringify({ level: "error", msg: "serve_transform_failed", name: (e as Error)?.name, message: String((e as Error)?.message ?? e).slice(0, 200) }));
    return null;
  }
}
