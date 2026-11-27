// Moderation and tags with Workers AI (design §4.3), inside the account. Upstream sent images to third-party
// services (moderatecontent.com or an nsfwjs endpoint); here the model sees a 512-pixel JPEG copy and nothing else.
// Nothing logs the image, the model's text or a URL.

import type { Env } from "../env.js";

const DEFAULT_MODERATION_MODEL = "@cf/mistralai/mistral-small-3.1-24b-instruct";
const DEFAULT_TAGS_MODEL = "@cf/microsoft/resnet-50";

export const UNSAFE_CATEGORIES = ["sexual_minors", "sexual", "nudity", "violence_graphic", "self_harm", "hate_symbols", "weapons_threat", "illegal_drugs"] as const;

const SYSTEM_PROMPT = [
  "You are a content safety classifier for a public image host.",
  "Decide whether the image is safe to show publicly to a general audience.",
  `Unsafe categories: ${UNSAFE_CATEGORIES.join(", ")}.`,
  'Reply with JSON only, no prose: {"verdict":"safe"|"unsafe","categories":[<unsafe categories that apply>]}.',
].join(" ");

/** A small JPEG copy of an image for the models (or null if the Images binding can't read it). */
export async function smallJpeg(env: Env, stream: ReadableStream): Promise<Uint8Array | null> {
  if (!env.IMAGES) return null;
  try {
    const out = await env.IMAGES.input(stream).transform({ width: 512, height: 512, fit: "scale-down" }).output({ format: "image/jpeg", quality: 80 });
    return new Uint8Array(await out.response().arrayBuffer());
  } catch {
    return null;
  }
}

function toDataUri(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return `data:image/jpeg;base64,${btoa(bin)}`;
}

export interface ModerationVerdict {
  /** pass: safe; fail: unsafe; error: the model's answer couldn't be read (the file is held). */
  outcome: "pass" | "fail" | "error";
  categories: string[];
}

/** Read the model's answer: JSON, possibly inside a ```json fence. Anything else is an error, never a pass. */
export function parseVerdict(text: unknown): ModerationVerdict {
  let v: { verdict?: unknown; categories?: unknown };
  if (text && typeof text === "object" && !Array.isArray(text)) {
    v = text as { verdict?: unknown; categories?: unknown }; // the binding may hand back JSON already parsed
  } else {
    if (typeof text !== "string") return { outcome: "error", categories: [] };
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start < 0 || end <= start) return { outcome: "error", categories: [] };
    try {
      v = JSON.parse(text.slice(start, end + 1)) as { verdict?: unknown; categories?: unknown };
    } catch {
      return { outcome: "error", categories: [] };
    }
  }
  try {
    const categories = Array.isArray(v.categories)
      ? v.categories.filter((c): c is string => typeof c === "string" && (UNSAFE_CATEGORIES as readonly string[]).includes(c))
      : [];
    if (v.verdict === "unsafe") return { outcome: "fail", categories };
    // A "safe" verdict that still names an unsafe category is treated as unsafe.
    if (v.verdict === "safe") return categories.length ? { outcome: "fail", categories } : { outcome: "pass", categories: [] };
    return { outcome: "error", categories: [] };
  } catch {
    return { outcome: "error", categories: [] };
  }
}

export async function moderate(env: Env, jpeg: Uint8Array): Promise<ModerationVerdict> {
  if (!env.AI) return { outcome: "error", categories: [] };
  const r = (await env.AI.run((env.MODERATION_MODEL ?? DEFAULT_MODERATION_MODEL) as Parameters<Ai["run"]>[0], {
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: [{ type: "text", text: "Classify this image." }, { type: "image_url", image_url: { url: toDataUri(jpeg) } }] },
    ],
    max_tokens: 200,
    temperature: 0,
  } as never)) as { response?: unknown; choices?: { message?: { content?: unknown } }[] };
  const answer = r?.response ?? r?.choices?.[0]?.message?.content;
  const verdict = parseVerdict(answer);
  if (verdict.outcome === "error") {
    // The answer's shape only (never its text), so an unreadable answer can be diagnosed from Workers Logs.
    console.warn(JSON.stringify({
      level: "warn",
      msg: "moderation_unreadable",
      responseType: Array.isArray(r?.response) ? "array" : typeof r?.response,
      hasChoices: Array.isArray(r?.choices),
      keys: r && typeof r === "object" ? Object.keys(r).slice(0, 12) : [],
      length: typeof answer === "string" ? answer.length : null,
    }));
  }
  return verdict;
}

/** Up to 3 labels the classifier is fairly sure of, lower-cased. Failures give no tags, never a failed run. */
export async function tagImage(env: Env, jpeg: Uint8Array): Promise<string[]> {
  if (!env.AI) return [];
  try {
    const r = (await env.AI.run((env.TAGS_MODEL ?? DEFAULT_TAGS_MODEL) as Parameters<Ai["run"]>[0], { image: Array.from(jpeg) } as never)) as unknown;
    const list = Array.isArray(r) ? r : Array.isArray((r as { result?: unknown })?.result) ? ((r as { result: unknown[] }).result) : [];
    return list
      .filter((x): x is { label: string; score: number } => typeof (x as { label?: unknown })?.label === "string" && typeof (x as { score?: unknown })?.score === "number")
      .filter((x) => x.score >= 0.4)
      .slice(0, 3)
      .map((x) => x.label.toLowerCase().slice(0, 40));
  } catch {
    return [];
  }
}
