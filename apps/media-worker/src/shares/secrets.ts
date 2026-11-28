// Share-link secrets (PV6; OWASP A02/A07). The token is 256 random bits and only its SHA-256 is stored. A
// password is stored as PBKDF2-SHA256 with a per-link salt, at the Workers ceiling of 100,000 iterations. After a
// correct password the guest holds an unlock proof, `<exp>.<mac>`, an HMAC keyed by the stored password hash: it
// can't be forged without the database row, and it stops working when the password changes or the link goes.

const enc = new TextEncoder();
export const PBKDF2_ITERATIONS = 100_000;
const UNLOCK_TTL_S = 12 * 3600;

export function b64url(bytes: ArrayBuffer | Uint8Array): string {
  const u = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let s = "";
  for (const b of u) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromB64url(s: string): Uint8Array {
  const b = atob(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4));
  return Uint8Array.from(b, (c) => c.charCodeAt(0));
}

export const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;

export function newShareToken(): string {
  return b64url(crypto.getRandomValues(new Uint8Array(32)));
}

export async function tokenHash(token: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", enc.encode(`share:${token}`));
  return Array.from(new Uint8Array(d), (b) => b.toString(16).padStart(2, "0")).join("");
}

async function pbkdf2(password: string, salt: Uint8Array, iterations: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveBits"]);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt: salt as Uint8Array<ArrayBuffer>, iterations }, key, 256));
}

export async function hashPassword(password: string, iterations = PBKDF2_ITERATIONS): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  return `pbkdf2-sha256$${iterations}$${b64url(salt)}$${b64url(await pbkdf2(password, salt, iterations))}`;
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a[i]! ^ b[i]!;
  return d === 0;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [alg, iter, salt, hash] = stored.split("$");
  const n = Number(iter);
  if (alg !== "pbkdf2-sha256" || !salt || !hash || !Number.isInteger(n) || n < 1 || n > PBKDF2_ITERATIONS) return false;
  return sameBytes(await pbkdf2(password, fromB64url(salt), n), fromB64url(hash));
}

async function mac(key: string, message: string): Promise<string> {
  const k = await crypto.subtle.importKey("raw", enc.encode(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return b64url(await crypto.subtle.sign("HMAC", k, enc.encode(message)));
}

export async function unlockProof(linkId: string, passwordHash: string, nowS: number): Promise<{ proof: string; maxAge: number }> {
  const exp = nowS + UNLOCK_TTL_S;
  return { proof: `${exp}.${await mac(passwordHash, `unlock:${linkId}:${exp}`)}`, maxAge: UNLOCK_TTL_S };
}

export async function verifyUnlock(proof: string | undefined, linkId: string, passwordHash: string, nowS: number): Promise<boolean> {
  if (!proof || proof.length > 200) return false;
  const [expS, m] = proof.split(".");
  const exp = Number(expS);
  if (!m || !Number.isInteger(exp) || exp < nowS) return false;
  return sameBytes(enc.encode(m), enc.encode(await mac(passwordHash, `unlock:${linkId}:${exp}`)));
}
