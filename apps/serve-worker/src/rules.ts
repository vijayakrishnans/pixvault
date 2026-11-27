// Derived from MarSeventh/CloudFlare-ImgBed@611153e:functions/file/fileTools.js (MIT), modified.
// ImgBed checks one instance-wide allowed-domain list and IP lists; here each library carries its own.

/** Referer allowed? An empty list allows everything; a missing Referer is allowed (direct visits, apps). */
export function referrerAllowed(referer: string | null, allowed: string[], selfHost: string): boolean {
  if (!allowed.length || !referer) return true;
  let host: string;
  try {
    host = new URL(referer).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (host === selfHost.toLowerCase()) return true;
  return allowed.some((d) => {
    const domain = d.trim().toLowerCase().replace(/^\*\./, "");
    return domain.length > 0 && (host === domain || host.endsWith(`.${domain}`));
  });
}

function ipv4ToInt(ip: string): number | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip);
  if (!m) return null;
  const parts = m.slice(1).map(Number);
  if (parts.some((p) => p > 255)) return null;
  return ((parts[0]! << 24) | (parts[1]! << 16) | (parts[2]! << 8) | parts[3]!) >>> 0;
}

/** An exact IP (v4 or v6) or an IPv4 CIDR range. */
export function ipMatches(ip: string, rule: string): boolean {
  const r = rule.trim();
  if (!r) return false;
  if (!r.includes("/")) return r.toLowerCase() === ip.toLowerCase();
  const [base, bitsRaw] = r.split("/");
  const bits = Number(bitsRaw);
  const a = ipv4ToInt(ip);
  const b = ipv4ToInt(base ?? "");
  if (a === null || b === null || !Number.isInteger(bits) || bits < 0 || bits > 32) return false;
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return (a & mask) === (b & mask);
}

export function ipAllowed(ip: string, allow: string[], block: string[]): boolean {
  if (ip && block.some((r) => ipMatches(ip, r))) return false;
  if (allow.length) return !!ip && allow.some((r) => ipMatches(ip, r));
  return true;
}
