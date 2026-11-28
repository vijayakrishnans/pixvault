// What a customer may give as a bucket (PV7; OWASP A10 SSRF): an https URL with a public host name, never an IP
// literal, a local or internal name, credentials in the URL, or an odd port. Requests are sent with redirects off.
// (Workers can't reach private networks anyway; this refuses them before anything is sent.) Plain http and local
// hosts are allowed only when ALLOW_TEST_ENDPOINTS is "true", which no deployed environment sets.

export interface BucketInput {
  endpoint: string;
  region: string;
  bucket: string;
  prefix: string;
  pathStyle: boolean;
}

const BUCKET_RE = /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/;
const REGION_RE = /^(auto|[a-z0-9-]{2,32})$/;
const BLOCKED_HOST = /(^localhost$|\.localhost$|\.local$|\.internal$|\.lan$|\.home$|\.corp$|^metadata(\.|$)|^instance-data(\.|$))/i;
const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/;

/** The input, normalised; or the fields that are wrong. */
export function validateBucket(raw: Record<string, unknown>, allowTest = false): { ok: true; value: BucketInput } | { ok: false; fields: Record<string, string[]> } {
  const fields: Record<string, string[]> = {};
  let endpoint = "";
  try {
    const u = new URL(String(raw.endpoint ?? ""));
    const host = u.hostname.toLowerCase();
    const isIp = IPV4.test(host) || host.startsWith("[") || host.includes(":");
    const okProto = u.protocol === "https:" || (allowTest && u.protocol === "http:");
    if (!okProto) fields.endpoint = ["Must start with https://"];
    else if (u.username || u.password) fields.endpoint = ["Must not contain a user name or password"];
    else if (!allowTest && (isIp || BLOCKED_HOST.test(host) || !host.includes("."))) fields.endpoint = ["Must be a public host name, not an IP address or a local name"];
    else if (!allowTest && u.port && u.port !== "443") fields.endpoint = ["Use the standard https port"];
    else if (u.pathname !== "/" || u.search || u.hash) fields.endpoint = ["Give the endpoint only, like https://s3.eu-central-1.amazonaws.com"];
    else endpoint = `${u.protocol}//${u.host}`;
  } catch {
    fields.endpoint = ["Must be a URL like https://s3.eu-central-1.amazonaws.com"];
  }
  const region = String(raw.region ?? "auto").trim() || "auto";
  if (!REGION_RE.test(region)) fields.region = ["Letters, digits and hyphens, or auto"];
  const bucket = String(raw.bucket ?? "").trim();
  if (!BUCKET_RE.test(bucket) || bucket.includes("..")) fields.bucket = ["3 to 63 lowercase letters, digits, dots or hyphens"];
  let prefix = String(raw.prefix ?? "").trim();
  if (prefix.length > 200 || prefix.startsWith("/") || prefix.split("/").some((p) => p === ".." || p === ".") || /[\u0000-\u001f\\]/.test(prefix)) fields.prefix = ["A folder path like pixvault/ (no leading /, no . or ..)"];
  else if (prefix && !prefix.endsWith("/")) prefix = `${prefix}/`;
  if (raw.pathStyle !== undefined && typeof raw.pathStyle !== "boolean") fields.pathStyle = ["Must be a boolean"];
  if (Object.keys(fields).length) return { ok: false, fields };
  return { ok: true, value: { endpoint, region, bucket, prefix, pathStyle: raw.pathStyle === true } };
}

/** An access key and secret, bounded and printable. */
export function validateSecret(raw: Record<string, unknown>): { ok: true; value: { accessKeyId: string; secretAccessKey: string } } | { ok: false; fields: Record<string, string[]> } {
  const fields: Record<string, string[]> = {};
  const id = raw.accessKeyId;
  const secret = raw.secretAccessKey;
  if (typeof id !== "string" || !/^[\x21-\x7e]{3,128}$/.test(id)) fields.accessKeyId = ["3 to 128 printable characters"];
  if (typeof secret !== "string" || !/^[\x21-\x7e]{6,256}$/.test(secret)) fields.secretAccessKey = ["6 to 256 printable characters"];
  if (Object.keys(fields).length) return { ok: false, fields };
  return { ok: true, value: { accessKeyId: id as string, secretAccessKey: secret as string } };
}
