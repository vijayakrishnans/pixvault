// Media (Pixvault) control-plane types. Every row is org-scoped; every repository method takes orgId first.

export type MediaRepositoryError =
  | { kind: "not_found" }
  | { kind: "conflict"; entity: string }
  | { kind: "internal"; message: string };

export type MediaResult<T> = { ok: true; value: T } | { ok: false; error: MediaRepositoryError };

export type LibraryRoleValue = "manager" | "editor" | "uploader" | "viewer";
export type PrincipalKindValue = "member" | "guest";

export interface Library {
  id: string;
  orgId: string;
  projectId: string;
  slug: string;
  name: string;
  visibilityDefault: "public" | "private";
  everyoneInOrg: boolean;
  moderationLevel: "off" | "standard" | "strict";
  retentionDays: number;
  settingsJson: string;
  status: "active" | "archived";
  /** Serving identity (220_media_serving): null until captured for libraries created before PV3. */
  orgSlug: string | null;
  signingKey: string | null;
  signingKeyVersion: number;
  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
  archivedAt: Date | null;
}

export interface LibraryMember {
  orgId: string;
  libraryId: string;
  principalKind: PrincipalKindValue;
  principalId: string;
  email: string | null;
  role: LibraryRoleValue;
  createdAt: Date;
}

export interface LibraryInvitation {
  id: string;
  orgId: string;
  libraryId: string;
  emailLower: string;
  role: "uploader" | "viewer";
  createdBy: string;
  createdAt: Date;
  expiresAt: Date;
  acceptedAt: Date | null;
  revokedAt: Date | null;
}

export interface StorageBackend {
  id: string;
  orgId: string;
  libraryId: string;
  kind: "managed-r2" | "s3-compatible";
  prefix: string;
  status: string;
}

export interface CreateLibraryInput {
  id: string;
  orgId: string;
  projectId: string;
  slug: string;
  name: string;
  visibilityDefault: "public" | "private";
  everyoneInOrg: boolean;
  settingsJson: string;
  createdBy: string;
  /** The creator, added as manager. Omitted when the creator is a service principal. */
  creator?: { principalId: string; email: string | null } | undefined;
  storageBackendId: string;
  orgSlug?: string | null | undefined;
  signingKey?: string | null | undefined;
  createdAt: Date;
}

export interface UpdateLibraryInput {
  name?: string | undefined;
  visibilityDefault?: "public" | "private" | undefined;
  everyoneInOrg?: boolean | undefined;
  moderationLevel?: "off" | "standard" | "strict" | undefined;
  retentionDays?: number | undefined;
  settingsJson?: string | undefined;
  updatedAt: Date;
}

export interface UpsertMemberInput {
  orgId: string;
  libraryId: string;
  principalKind: PrincipalKindValue;
  principalId: string;
  email: string | null;
  role: LibraryRoleValue;
  createdBy: string;
  at: Date;
}

export interface CreateInvitationInput {
  id: string;
  orgId: string;
  libraryId: string;
  emailLower: string;
  role: "uploader" | "viewer";
  createdBy: string;
  createdAt: Date;
  expiresAt: Date;
}

export interface OrgUsage {
  storageBytes: number;
  uploadsThisMonth: number;
  uploadBytesThisMonth: number;
}

export interface OrgLimitOverrides {
  storageBytesLimit: number | null;
  uploadsPerMonthLimit: number | null;
  maxFileBytes: number | null;
}

export interface MediaRepository {
  createLibrary(input: CreateLibraryInput): Promise<MediaResult<Library>>;
  getLibrary(orgId: string, libraryId: string): Promise<MediaResult<Library>>;
  /** Active libraries in one org, oldest first. */
  listLibraries(orgId: string): Promise<MediaResult<Library[]>>;
  updateLibrary(orgId: string, libraryId: string, input: UpdateLibraryInput): Promise<MediaResult<Library>>;
  archiveLibrary(orgId: string, libraryId: string, at: Date): Promise<MediaResult<Library>>;

  listMembers(orgId: string, libraryId: string): Promise<MediaResult<LibraryMember[]>>;
  /** Every library role the principal holds in one org (all libraries). */
  listPrincipalRoles(orgId: string, principalId: string): Promise<MediaResult<LibraryMember[]>>;
  /** Orgs and libraries where the principal is a guest, across orgs (for the guest's library list). */
  listGuestMemberships(principalId: string): Promise<MediaResult<LibraryMember[]>>;
  upsertMember(input: UpsertMemberInput): Promise<MediaResult<LibraryMember>>;
  removeMember(orgId: string, libraryId: string, principalId: string): Promise<MediaResult<true>>;
  countManagers(orgId: string, libraryId: string): Promise<MediaResult<number>>;

  createInvitation(input: CreateInvitationInput): Promise<MediaResult<LibraryInvitation>>;
  listOpenInvitations(orgId: string, libraryId: string, now: Date): Promise<MediaResult<LibraryInvitation[]>>;
  revokeInvitation(orgId: string, libraryId: string, invitationId: string, at: Date): Promise<MediaResult<true>>;
  /** Open, unexpired invitations for one email, across orgs. */
  listInvitationsForEmail(emailLower: string, now: Date): Promise<MediaResult<LibraryInvitation[]>>;
  /** Mark accepted and add the guest member, atomically. */
  acceptInvitation(invitation: LibraryInvitation, principalId: string, at: Date): Promise<MediaResult<LibraryMember>>;

  getStorageBackend(orgId: string, libraryId: string): Promise<MediaResult<StorageBackend>>;

  /** Fill in a library's org slug and signing key where they're missing (never overwrites). */
  setServingIdentity(orgId: string, libraryId: string, orgSlug: string, signingKey: string, at: Date): Promise<MediaResult<Library>>;
  /** Stored bytes (all time) and this month's uploads for one org. `month` is 'YYYY-MM'. */
  getUsage(orgId: string, month: string): Promise<MediaResult<OrgUsage>>;
  getLimitOverrides(orgId: string): Promise<MediaResult<OrgLimitOverrides | null>>;
  /** Count one committed upload: +1 upload and +bytes this month; +storedBytes to the stored total (0 when deduplicated). */
  recordUpload(orgId: string, month: string, bytes: number, storedBytes: number, at: Date): Promise<MediaResult<true>>;
  /** Release stored bytes when a blob is purged. Never goes below zero. */
  releaseStorage(orgId: string, bytes: number, at: Date): Promise<MediaResult<true>>;
  /** Add stored bytes without counting an upload (e.g. a sanitized copy of an image). */
  addStorage(orgId: string, bytes: number, at: Date): Promise<MediaResult<true>>;
  /** True when the org has no active or trialing subscription to a paid plan. */
  orgIsOnFreePlan(orgId: string): Promise<MediaResult<boolean>>;
  recordPipelineFailure(input: PipelineFailureInput): Promise<MediaResult<true>>;
  listPipelineFailures(filter: { orgId?: string; libraryId?: string; status?: "open" | "replayed" | "resolved"; limit: number }): Promise<MediaResult<PipelineFailure[]>>;
  /** Record a report; a file with an open case gets its report count raised instead of a new case. */
  reportAbuse(input: AbuseReportInput): Promise<MediaResult<{ caseId: string; created: boolean }>>;
  listAbuseCases(filter: { status?: AbuseCase["status"]; limit: number }): Promise<MediaResult<AbuseCase[]>>;
  getAbuseCase(id: string): Promise<MediaResult<AbuseCase>>;
  decideAbuseCase(id: string, status: "actioned" | "dismissed", decidedBy: string, note: string | null, at: Date): Promise<MediaResult<AbuseCase>>;
  isPlatformOperator(subjectId: string): Promise<MediaResult<boolean>>;
  getOrgSuspension(orgId: string): Promise<MediaResult<{ suspendedAt: string; reason: string | null } | null>>;
  setOrgSuspension(orgId: string, suspended: boolean, reason: string | null, decidedBy: string, at: Date): Promise<MediaResult<true>>;
  /** Emails of platform users by id (uuid), for mention emails. Unknown ids are left out. */
  userEmails(userIds: string[]): Promise<MediaResult<Map<string, string>>>;
  // share links (PV6)
  createShareLink(input: ShareLinkInput): Promise<MediaResult<ShareLink>>;
  listShareLinks(orgId: string, libraryId: string, filter: { targetKind?: ShareLink["targetKind"]; targetId?: string; limit: number }): Promise<MediaResult<ShareLink[]>>;
  getShareLink(orgId: string, libraryId: string, id: string): Promise<MediaResult<ShareLink>>;
  /** By token hash, across every org (the token is the whole credential). */
  getShareLinkByTokenHash(tokenHash: string): Promise<MediaResult<ShareLink>>;
  revokeShareLink(orgId: string, libraryId: string, id: string, at: Date): Promise<MediaResult<ShareLink>>;
  recordShareOpen(id: string, at: Date): Promise<MediaResult<true>>;
  /** Count one download if the link is live and under its limit; false when the limit is reached. */
  consumeShareDownload(id: string, at: Date): Promise<MediaResult<boolean>>;
  // upload links (PV6)
  createUploadLink(input: UploadLinkInput): Promise<MediaResult<UploadLink>>;
  listUploadLinks(orgId: string, libraryId: string, limit: number): Promise<MediaResult<UploadLink[]>>;
  getUploadLinkByTokenHash(tokenHash: string): Promise<MediaResult<UploadLink>>;
  revokeUploadLink(orgId: string, libraryId: string, id: string, at: Date): Promise<MediaResult<UploadLink>>;
  /** Reserve one file of `bytes` against the link's limits; false when a limit would be passed or the link is gone. */
  reserveUpload(link: UploadLink, bytes: number, at: Date): Promise<MediaResult<boolean>>;
  /** Give back a reservation whose upload failed. */
  releaseUpload(id: string, bytes: number): Promise<MediaResult<true>>;
  /** Mark a file's open failures replayed or resolved. */
  settlePipelineFailures(orgId: string, libraryId: string, fileId: string, status: "replayed" | "resolved", at: Date): Promise<MediaResult<true>>;
}

export interface UploadLinkLimits {
  maxFiles: number;
  maxFileBytes: number;
  maxTotalBytes: number;
  /** MIME patterns like "image/*" or "application/pdf"; empty means any type the library allows. */
  allowedTypes: string[];
}

export interface UploadLink {
  id: string;
  orgId: string;
  libraryId: string;
  folderPath: string;
  label: string;
  tokenHash: string;
  limits: UploadLinkLimits;
  requiresReview: boolean;
  uploads: number;
  bytes: number;
  createdBy: string;
  expiresAt: string | null;
  revokedAt: string | null;
  createdAt: string;
}

export interface UploadLinkInput {
  orgId: string;
  libraryId: string;
  folderPath: string;
  label: string;
  tokenHash: string;
  limits: UploadLinkLimits;
  requiresReview: boolean;
  expiresAt: Date | null;
  createdBy: string;
  at: Date;
}

export interface ShareLink {
  id: string;
  orgId: string;
  libraryId: string;
  targetKind: "file" | "folder" | "collection";
  /** File id (uuid), folder path, or collection id. */
  targetId: string;
  targetLabel: string;
  mode: "view" | "download";
  tokenHash: string;
  /** "pbkdf2-sha256$<iterations>$<salt b64url>$<hash b64url>", or null. Never leaves media-worker. */
  passwordHash: string | null;
  expiresAt: string | null;
  maxDownloads: number | null;
  downloads: number;
  opens: number;
  lastOpenedAt: string | null;
  createdBy: string;
  revokedAt: string | null;
  createdAt: string;
}

export interface ShareLinkInput {
  orgId: string;
  libraryId: string;
  targetKind: ShareLink["targetKind"];
  targetId: string;
  targetLabel: string;
  mode: ShareLink["mode"];
  tokenHash: string;
  passwordHash: string | null;
  expiresAt: Date | null;
  maxDownloads: number | null;
  createdBy: string;
  at: Date;
}

export interface PipelineFailureInput {
  orgId: string;
  libraryId: string;
  fileId: string;
  sha256: string;
  step: string;
  errorName: string;
  at: Date;
}

export interface PipelineFailure {
  id: string;
  orgId: string;
  libraryId: string;
  fileId: string;
  sha256: string;
  step: string;
  errorName: string;
  status: "open" | "replayed" | "resolved";
  createdAt: string;
  resolvedAt: string | null;
}

export const ABUSE_CATEGORIES = ["csam", "sexual", "violence", "hate", "harassment", "copyright", "malware", "spam", "other"] as const;
export type AbuseCategory = (typeof ABUSE_CATEGORIES)[number];

export interface AbuseReportInput {
  orgId: string;
  libraryId: string;
  fileId: string;
  sha256: string;
  category: AbuseCategory;
  details: string | null;
  reporterEmail: string | null;
  at: Date;
}

export interface AbuseCase {
  id: string;
  orgId: string;
  libraryId: string;
  fileId: string;
  sha256: string;
  category: AbuseCategory;
  details: string | null;
  reporterEmail: string | null;
  reportCount: number;
  status: "open" | "actioned" | "dismissed";
  decidedBy: string | null;
  decisionNote: string | null;
  createdAt: string;
  updatedAt: string;
}
