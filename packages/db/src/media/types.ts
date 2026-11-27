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
  /** Mark a file's open failures replayed or resolved. */
  settlePipelineFailures(orgId: string, libraryId: string, fileId: string, status: "replayed" | "resolved", at: Date): Promise<MediaResult<true>>;
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
