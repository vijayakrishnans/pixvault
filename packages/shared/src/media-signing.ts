// Signed URLs for private files (design §2.5). One HMAC-SHA256 key per library, rotatable by version. The
// signature covers the library, the exact path and the expiry, so a URL can't be moved to another file, another
// library or a later time. WebCrypto only: the same code runs in media-worker (signing) and serve-worker
// (verifying).

const enc = new TextEncoder();

function b64url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromB64url(s: string): Uint8Array<ArrayBuffer> | null {
  if (!/^[A-Za-z0-9_-]*$/.test(s)) return null;
  try {
    const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4));
    const out = new Uint8Array(new ArrayBuffer(bin.length));
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

/** A new 32-byte signing key, base64url. */
export function newSigningKey(): string {
  return b64url(crypto.getRandomValues(new Uint8Array(32)));
}

async function hmac(keyB64: string, message: string): Promise<Uint8Array> {
  const raw = fromB64url(keyB64);
  if (!raw || raw.length < 16) throw new Error("invalid signing key");
  const key = await crypto.subtle.importKey("raw", raw, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(message)));
}

const canonical = (libraryId: string, path: string, exp: number, version: number) => `v${version}\n${libraryId}\n${path}\n${exp}`;

/** `sig` for `?exp=&sig=`: the key version travels inside the signature string (`<version>.<mac>`). */
export async function signPath(keyB64: string, version: number, libraryId: string, path: string, expSeconds: number): Promise<string> {
  return `${version}.${b64url(await hmac(keyB64, canonical(libraryId, path, expSeconds, version)))}`;
}

function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!;
  return diff === 0;
}

export type VerifyResult = "ok" | "expired" | "invalid";

/** Verify `sig` for this library and path. `keys` maps version → key (the current one and, during rotation, the previous one). */
export async function verifyPath(
  keys: Record<string, string>,
  libraryId: string,
  path: string,
  expParam: string | null,
  sig: string | null,
  nowSeconds: number,
): Promise<VerifyResult> {
  if (!sig || !expParam || !/^\d{1,12}$/.test(expParam)) return "invalid";
  const m = /^(\d{1,6})\.([A-Za-z0-9_-]{43})$/.exec(sig);
  if (!m) return "invalid";
  const key = keys[m[1]!];
  if (!key) return "invalid";
  const given = fromB64url(m[2]!);
  if (!given) return "invalid";
  const exp = Number(expParam);
  const expected = await hmac(key, canonical(libraryId, path, exp, Number(m[1])));
  if (!timingSafeEqual(given, expected)) return "invalid";
  return exp >= nowSeconds ? "ok" : "expired";
}
