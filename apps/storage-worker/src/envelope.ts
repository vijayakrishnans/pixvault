// Envelope encryption for customer bucket credentials (PV7; OWASP A02/A04). Each backend gets its own random data
// key; the credentials are sealed with it (AES-256-GCM), and the data key is sealed with the key-encryption key
// (STORAGE_KEK, a Worker secret only this worker holds). Both seals are bound to the backend's org, library and id
// as additional data, so a sealed value copied onto another row won't open. Nothing here is logged.

const enc = new TextEncoder();
const dec = new TextDecoder();

export interface BucketSecret {
  accessKeyId: string;
  secretAccessKey: string;
}

interface Sealed {
  v: 1;
  /** KEK id, for rotation. */
  kid: string;
  wdek: string;
  wiv: string;
  iv: string;
  ct: string;
}

function b64(u: Uint8Array): string {
  let s = "";
  for (const b of u) s += String.fromCharCode(b);
  return btoa(s);
}
function unb64(s: string): Uint8Array {
  return Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
}

/** STORAGE_KEK is 64 hex characters (32 bytes). */
export function parseKek(hex: string | undefined): Uint8Array | null {
  if (!hex || !/^[0-9a-f]{64}$/i.test(hex.trim())) return null;
  return Uint8Array.from(hex.trim().match(/../g)!.map((h) => parseInt(h, 16)));
}

async function aesKey(raw: Uint8Array): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", raw as Uint8Array<ArrayBuffer>, "AES-GCM", false, ["encrypt", "decrypt"]);
}

export const aadFor = (orgId: string, libraryId: string, backendId: string) => enc.encode(`pixvault-storage:${orgId}:${libraryId}:${backendId}`);

export async function seal(kek: Uint8Array, secret: BucketSecret, aad: Uint8Array, kid = "k1"): Promise<string> {
  const dek = crypto.getRandomValues(new Uint8Array(32));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const wiv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: aad as Uint8Array<ArrayBuffer> }, await aesKey(dek), enc.encode(JSON.stringify(secret))));
  const wdek = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: wiv, additionalData: aad as Uint8Array<ArrayBuffer> }, await aesKey(kek), dek));
  dek.fill(0);
  const sealed: Sealed = { v: 1, kid, wdek: b64(wdek), wiv: b64(wiv), iv: b64(iv), ct: b64(ct) };
  return JSON.stringify(sealed);
}

/** Open sealed credentials; null when the value, the key or the binding doesn't match. */
export async function open(kek: Uint8Array, sealedJson: string, aad: Uint8Array): Promise<BucketSecret | null> {
  try {
    const s = JSON.parse(sealedJson) as Sealed;
    if (s.v !== 1) return null;
    const dek = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: unb64(s.wiv) as Uint8Array<ArrayBuffer>, additionalData: aad as Uint8Array<ArrayBuffer> }, await aesKey(kek), unb64(s.wdek) as Uint8Array<ArrayBuffer>));
    const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: unb64(s.iv) as Uint8Array<ArrayBuffer>, additionalData: aad as Uint8Array<ArrayBuffer> }, await aesKey(dek), unb64(s.ct) as Uint8Array<ArrayBuffer>);
    dek.fill(0);
    const v = JSON.parse(dec.decode(pt)) as BucketSecret;
    return typeof v.accessKeyId === "string" && typeof v.secretAccessKey === "string" ? v : null;
  } catch {
    return null;
  }
}
