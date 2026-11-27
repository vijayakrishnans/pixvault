// Media (Pixvault) wire types: libraries, library roles, members and guest invitations.
// Design of record: specs/epics/pixvault-team-media/design.md §1 and §2.
//
// A library is a Cirrus project with media settings. Library roles sit on top of org roles and are evaluated by
// policy-worker (packages/policy-engine), never by the calling worker alone.

/** Roles a principal can hold on one library. */
export type LibraryRole = "manager" | "editor" | "uploader" | "viewer";
export const LIBRARY_ROLES: readonly LibraryRole[] = ["manager", "editor", "uploader", "viewer"] as const;

/** Guests (outside the org) may only upload or view. */
export const GUEST_LIBRARY_ROLES: readonly LibraryRole[] = ["uploader", "viewer"] as const;

export type LibraryPrincipalKind = "member" | "guest";

/** Every action the media surface authorizes through policy-worker. */
export const LIBRARY_ACTIONS = [
  "library.create",
  "library.read",
  "library.update",
  "library.delete",
  "library.member.list",
  "library.member.write",
  "file.list",
  "file.list.own",
  "file.read",
  "file.read.own",
  "file.download",
  "file.upload",
  "file.update",
  "file.delete",
  "file.restore",
  "share.create",
  "upload_link.manage",
  "review.decide",
  "storage.manage",
  "domain.manage",
] as const;
export type LibraryAction = (typeof LIBRARY_ACTIONS)[number];

/**
 * A library-role fact, supplied to policy-worker beside the org role facts. media-worker builds these from
 * `media_library_members` for the requesting subject; the engine ignores any fact whose org or library doesn't
 * match the resource.
 */
export interface LibraryRoleFact {
  kind: "library_role";
  role: LibraryRole;
  principalKind: LibraryPrincipalKind;
  scope: { kind: "library"; orgId: string; libraryId: string };
}

/** Library attributes the engine needs: passed as `context.attributes.library`. */
export interface LibraryPolicyAttributes {
  libraryId: string;
  everyoneInOrg: boolean;
}

export type LibraryVisibility = "public" | "private";
export type ModerationLevel = "off" | "standard" | "strict";

export interface LibrarySettings {
  /** Allowed MIME patterns for uploads, e.g. ["image/*", "application/pdf"]. Empty = the plan default. */
  allowedTypes: string[];
  /** Max upload size in bytes; null = the plan default. */
  maxUploadBytes: number | null;
  /** Referrer hosts allowed to hotlink public files; empty = any. */
  allowedReferrers: string[];
  ipAllowList: string[];
  ipBlockList: string[];
  randomApiEnabled: boolean;
  transformPresets: string[];
}

export interface PublicLibrary {
  id: string; // lib_…
  orgId: string; // org_…
  projectId: string; // prj_…
  slug: string;
  name: string;
  visibilityDefault: LibraryVisibility;
  everyoneInOrg: boolean;
  moderationLevel: ModerationLevel;
  retentionDays: number;
  settings: LibrarySettings;
  status: "active" | "archived";
  /** The caller's effective role on this library (implicit for org owners/admins, or from everyoneInOrg). */
  myRole: LibraryRole | null;
  createdAt: string;
  updatedAt: string;
}

export interface CreateLibraryRequest {
  name: string;
  slug?: string;
  visibilityDefault?: LibraryVisibility;
  everyoneInOrg?: boolean;
}

export interface UpdateLibraryRequest {
  name?: string;
  visibilityDefault?: LibraryVisibility;
  everyoneInOrg?: boolean;
  moderationLevel?: ModerationLevel;
  retentionDays?: number;
  settings?: Partial<LibrarySettings>;
}

export interface LibraryResponse {
  library: PublicLibrary;
}
export interface ListLibrariesResponse {
  libraries: PublicLibrary[];
}

export interface PublicLibraryMember {
  libraryId: string;
  principalKind: LibraryPrincipalKind;
  principalId: string; // usr_…
  email: string | null;
  role: LibraryRole;
  createdAt: string;
}

export interface PutLibraryMemberRequest {
  role: LibraryRole;
}

export interface ListLibraryMembersResponse {
  members: PublicLibraryMember[];
  invitations: PublicLibraryInvitation[];
}

/** A pending guest invitation: accepted when a signed-in user with this verified email calls accept. */
export interface PublicLibraryInvitation {
  id: string; // lbi_…
  libraryId: string;
  email: string;
  role: LibraryRole;
  expiresAt: string;
  createdAt: string;
}

export interface CreateLibraryInvitationRequest {
  email: string;
  role: LibraryRole;
}

export interface LibraryInvitationResponse {
  invitation: PublicLibraryInvitation;
}

export interface AcceptLibraryInvitationsResponse {
  /** Libraries the caller joined as a guest by this call. */
  libraries: PublicLibrary[];
}

/** Default settings for a new library. */
export const DEFAULT_LIBRARY_SETTINGS: LibrarySettings = {
  allowedTypes: [],
  maxUploadBytes: null,
  allowedReferrers: [],
  ipAllowList: [],
  ipBlockList: [],
  randomApiEnabled: false,
  transformPresets: ["thumb", "small", "medium", "large"],
};

export const DEFAULT_RETENTION_DAYS = 30;

// ── Files and uploads (PV2) ─────────────────────────────────────────────

/** Bytes per multipart part. R2 needs ≥ 5 MiB for every part but the last; 32 MiB keeps a 2 GB file at 60 parts. */
export const UPLOAD_PART_SIZE = 32 * 1024 * 1024;
/** Upload sessions expire (and their parts are aborted) this long after creation. */
export const UPLOAD_SESSION_TTL_MS = 24 * 60 * 60 * 1000;

export type FileStatus = "processing" | "held" | "public" | "private" | "flagged" | "trashed";

export interface PublicFile {
  id: string; // fil_…
  libraryId: string;
  path: string; // "/folder/name.png"
  name: string;
  folder: string; // "/folder"
  size: number;
  mime: string;
  sha256: string;
  visibility: LibraryVisibility;
  status: FileStatus;
  version: number;
  uploadedBy: string;
  createdAt: string;
  updatedAt: string;
  trashedAt: string | null;
  /** Public URL (public files only); private files get a signed URL from POST …/signed-url. */
  url: string | null;
}

export interface SignedUrlRequest {
  /** Seconds, 60 to 604800 (7 days). Default 3600. */
  expiresIn?: number;
}

export interface SignedUrlResponse {
  url: string;
  expiresAt: string;
}

export interface CreateUploadSessionRequest {
  /** File name; the path is folder + "/" + name. */
  name: string;
  folder?: string;
  size: number;
  /** Lowercase hex SHA-256 of the whole file, computed by the client. Verified at commit. */
  sha256: string;
  mime?: string;
  visibility?: LibraryVisibility;
  /** Replace the file at this path, keeping the old bytes as a version. Without it, an existing path is a 409. */
  replace?: boolean;
}

export interface PublicUploadSession {
  id: string; // ups_…
  libraryId: string;
  path: string;
  size: number;
  sha256: string;
  mode: "single" | "multipart";
  partSize: number;
  partCount: number;
  /** Part numbers (1-based) already stored; resume from the first missing one. */
  uploadedParts: number[];
  expiresAt: string;
}

export interface CreateUploadSessionResponse {
  /** Present when bytes must be sent. */
  session?: PublicUploadSession;
  /** Present when the library already holds these bytes and the caller may read them: the file was created directly. */
  file?: PublicFile;
  deduplicated?: boolean;
}

export interface CommitUploadResponse {
  file: PublicFile;
  /** True when the bytes matched a blob already in the library, so no storage was added. */
  deduplicated: boolean;
}

export interface ListFilesResponse {
  files: PublicFile[];
  nextCursor: string | null;
}

export interface PublicFileVersion {
  version: number;
  size: number;
  sha256: string;
  createdBy: string;
  createdAt: string;
  current: boolean;
}

export interface PublicMediaUsage {
  storageBytes: number;
  storageBytesLimit: number;
  uploadsThisMonth: number;
  uploadsPerMonthLimit: number;
  maxFileBytes: number;
}

/** Plan defaults when an org has no media_org_limits row (PV2; plans arrive in PV11). */
export const DEFAULT_MEDIA_LIMITS = {
  storageBytesLimit: 10 * 1024 * 1024 * 1024,
  uploadsPerMonthLimit: 2000,
  maxFileBytes: 2 * 1024 * 1024 * 1024,
} as const;
