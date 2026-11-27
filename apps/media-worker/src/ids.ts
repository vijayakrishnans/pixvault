import { uuidFromPublicId, uuidToHex, type Uuid } from "@saas/db/ids";

export function generateRequestId(): string {
  const buf = new Uint8Array(12);
  crypto.getRandomValues(buf);
  return `req_${Array.from(buf, (b) => b.toString(16).padStart(2, "0")).join("")}`;
}

const pub = (prefix: string) => (uuid: string) => `${prefix}_${uuidToHex(uuid)}`;
const parse = (prefix: string) => (publicId: string): Uuid | null => uuidFromPublicId(publicId, prefix);

export const orgPublicId = pub("org");
export const parseOrgPublicId = parse("org");
export const projectPublicId = pub("prj");
export const parseProjectPublicId = parse("prj");
/** Libraries: `lib_<32 hex>`. */
export const libraryPublicId = pub("lib");
export const parseLibraryPublicId = parse("lib");
/** Guest invitations: `lbi_<32 hex>`. */
export const invitationPublicId = pub("lbi");
export const parseInvitationPublicId = parse("lbi");

/** Principal ids are passed through as the edge's subject ids (e.g. `usr_…`); this only bounds their shape. */
const PRINCIPAL_RE = /^[A-Za-z0-9_-]{1,128}$/;
export function isPrincipalId(v: string): boolean {
  return PRINCIPAL_RE.test(v);
}

/** The actor as stored in created_by columns: the decoded UUID of `usr_…`/`sp_…`, as Cirrus stores actors. */
export function actorUuid(subjectId: string): string {
  return uuidFromPublicId(subjectId) ?? subjectId;
}
