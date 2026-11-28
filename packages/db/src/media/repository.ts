import type { SqlExecutor, SqlStatement } from "../d1/executor.js";
import { executeBatch } from "../d1/executor.js";
import { isUniqueViolation } from "../d1/errors.js";
import type {
  ShareLink,
  UploadLink,
  UploadLinkLimits,
  AbuseCase,
  PipelineFailure,
  CreateInvitationInput,
  CreateLibraryInput,
  Library,
  LibraryInvitation,
  LibraryMember,
  MediaRepository,
  MediaResult,
  StorageBackend,
  UpdateLibraryInput,
  UpsertMemberInput,
  OrgUsage,
  OrgLimitOverrides,
} from "./types.js";

type Row = Record<string, unknown>;

const d = (v: unknown): Date | null => (v ? new Date(v as string) : null);

function mapLibrary(row: Row): Library {
  return {
    id: row.id as string,
    orgId: row.org_id as string,
    projectId: row.project_id as string,
    slug: row.slug as string,
    name: row.name as string,
    visibilityDefault: row.visibility_default as Library["visibilityDefault"],
    everyoneInOrg: Number(row.everyone_in_org) === 1,
    moderationLevel: row.moderation_level as Library["moderationLevel"],
    retentionDays: Number(row.retention_days),
    settingsJson: (row.settings_json as string) || "{}",
    status: row.status as Library["status"],
    orgSlug: (row.org_slug as string | null) ?? null,
    signingKey: (row.signing_key as string | null) ?? null,
    signingKeyVersion: Number(row.signing_key_version ?? 1),
    createdBy: row.created_by as string,
    createdAt: new Date(row.created_at as string),
    updatedAt: new Date(row.updated_at as string),
    archivedAt: d(row.archived_at),
  };
}

function mapMember(row: Row): LibraryMember {
  return {
    orgId: row.org_id as string,
    libraryId: row.library_id as string,
    principalKind: row.principal_kind as LibraryMember["principalKind"],
    principalId: row.principal_id as string,
    email: (row.email as string | null) ?? null,
    role: row.role as LibraryMember["role"],
    createdAt: new Date(row.created_at as string),
  };
}

function mapInvitation(row: Row): LibraryInvitation {
  return {
    id: row.id as string,
    orgId: row.org_id as string,
    libraryId: row.library_id as string,
    emailLower: row.email_lower as string,
    role: row.role as LibraryInvitation["role"],
    createdBy: row.created_by as string,
    createdAt: new Date(row.created_at as string),
    expiresAt: new Date(row.expires_at as string),
    acceptedAt: d(row.accepted_at),
    revokedAt: d(row.revoked_at),
  };
}

function internal<T>(message: string): MediaResult<T> {
  return { ok: false, error: { kind: "internal", message } };
}
const notFound = <T>(): MediaResult<T> => ({ ok: false, error: { kind: "not_found" } });

/** The managed-R2 prefix for a library. Every managed object key starts with it (design §1.1). */
function toUploadLink(r: Row): UploadLink {
  let limits: UploadLinkLimits = { maxFiles: 0, maxFileBytes: 0, maxTotalBytes: 0, allowedTypes: [] };
  try {
    limits = { ...limits, ...(JSON.parse(String(r.limits_json ?? "{}")) as Partial<UploadLinkLimits>) };
  } catch {
    /* a link with unreadable limits accepts nothing */
  }
  return {
    id: String(r.id),
    orgId: String(r.org_id),
    libraryId: String(r.library_id),
    folderPath: String(r.folder_path),
    label: String(r.label ?? ""),
    tokenHash: String(r.token_hash),
    limits,
    requiresReview: Number(r.requires_review) === 1,
    uploads: Number(r.uploads ?? 0),
    bytes: Number(r.bytes ?? 0),
    createdBy: String(r.created_by),
    expiresAt: r.expires_at == null ? null : String(r.expires_at),
    revokedAt: r.revoked_at == null ? null : String(r.revoked_at),
    createdAt: String(r.created_at),
  };
}

function toShareLink(r: Row): ShareLink {
  return {
    id: String(r.id),
    orgId: String(r.org_id),
    libraryId: String(r.library_id),
    targetKind: r.target_kind as ShareLink["targetKind"],
    targetId: String(r.target_id),
    targetLabel: String(r.target_label ?? ""),
    mode: r.mode as ShareLink["mode"],
    tokenHash: String(r.token_hash),
    passwordHash: r.password_hash == null ? null : String(r.password_hash),
    expiresAt: r.expires_at == null ? null : String(r.expires_at),
    maxDownloads: r.max_downloads == null ? null : Number(r.max_downloads),
    downloads: Number(r.downloads ?? 0),
    opens: Number(r.opens ?? 0),
    lastOpenedAt: r.last_opened_at == null ? null : String(r.last_opened_at),
    createdBy: String(r.created_by),
    revokedAt: r.revoked_at == null ? null : String(r.revoked_at),
    createdAt: String(r.created_at),
  };
}

export function managedPrefix(orgId: string, libraryId: string): string {
  return `org/${orgId}/lib/${libraryId}/`;
}

export function createMediaRepository(executor: SqlExecutor): MediaRepository {
  return {
    async createLibrary(input: CreateLibraryInput) {
      const at = input.createdAt.toISOString();
      const statements: SqlStatement[] = [
        {
          text: `INSERT INTO media_libraries
                   (id, org_id, project_id, slug, name, visibility_default, everyone_in_org, settings_json,
                    created_by, created_at, updated_at, org_slug, signing_key)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $10, $11, $12)`,
          params: [
            input.id,
            input.orgId,
            input.projectId,
            input.slug,
            input.name,
            input.visibilityDefault,
            input.everyoneInOrg ? 1 : 0,
            input.settingsJson,
            input.createdBy,
            at,
            input.orgSlug ?? null,
            input.signingKey ?? null,
          ],
        },
        {
          text: `INSERT INTO media_storage_backends (id, org_id, library_id, kind, prefix, status, created_at, updated_at)
                 VALUES ($1, $2, $3, 'managed-r2', $4, 'active', $5, $5)`,
          params: [input.storageBackendId, input.orgId, input.id, managedPrefix(input.orgId, input.id), at],
        },
      ];
      if (input.creator) {
        statements.push({
          text: `INSERT INTO media_library_members
                   (org_id, library_id, principal_kind, principal_id, email, role, created_by, created_at, updated_at)
                 VALUES ($1, $2, 'member', $3, $4, 'manager', $5, $6, $6)`,
          params: [input.orgId, input.id, input.creator.principalId, input.creator.email, input.createdBy, at],
        });
      }
      try {
        await executeBatch(executor, statements);
      } catch (err) {
        if (isUniqueViolation(err)) return { ok: false, error: { kind: "conflict", entity: "library" } };
        return internal("Failed to create library");
      }
      return this.getLibrary(input.orgId, input.id);
    },

    async getLibrary(orgId, libraryId) {
      try {
        const r = await executor.execute<Row>(`SELECT * FROM media_libraries WHERE org_id = $1 AND id = $2`, [
          orgId,
          libraryId,
        ]);
        return r.rowCount === 0 ? notFound() : { ok: true, value: mapLibrary(r.rows[0]!) };
      } catch {
        return internal("Failed to get library");
      }
    },

    async listLibraries(orgId) {
      try {
        const r = await executor.execute<Row>(
          `SELECT * FROM media_libraries WHERE org_id = $1 AND status = 'active' ORDER BY created_at ASC, id ASC`,
          [orgId],
        );
        return { ok: true, value: r.rows.map(mapLibrary) };
      } catch {
        return internal("Failed to list libraries");
      }
    },

    async updateLibrary(orgId, libraryId, input: UpdateLibraryInput) {
      const sets: string[] = [];
      const params: unknown[] = [orgId, libraryId];
      const add = (col: string, v: unknown) => {
        params.push(v);
        sets.push(`${col} = $${params.length}`);
      };
      if (input.name !== undefined) add("name", input.name);
      if (input.visibilityDefault !== undefined) add("visibility_default", input.visibilityDefault);
      if (input.everyoneInOrg !== undefined) add("everyone_in_org", input.everyoneInOrg ? 1 : 0);
      if (input.moderationLevel !== undefined) add("moderation_level", input.moderationLevel);
      if (input.retentionDays !== undefined) add("retention_days", input.retentionDays);
      if (input.settingsJson !== undefined) add("settings_json", input.settingsJson);
      add("updated_at", input.updatedAt.toISOString());
      try {
        const r = await executor.execute<Row>(
          `UPDATE media_libraries SET ${sets.join(", ")} WHERE org_id = $1 AND id = $2 AND status = 'active' RETURNING *`,
          params,
        );
        return r.rowCount === 0 ? notFound() : { ok: true, value: mapLibrary(r.rows[0]!) };
      } catch {
        return internal("Failed to update library");
      }
    },

    async archiveLibrary(orgId, libraryId, at) {
      try {
        const r = await executor.execute<Row>(
          `UPDATE media_libraries SET status = 'archived', archived_at = $3, updated_at = $3
           WHERE org_id = $1 AND id = $2 AND status = 'active' RETURNING *`,
          [orgId, libraryId, at.toISOString()],
        );
        return r.rowCount === 0 ? notFound() : { ok: true, value: mapLibrary(r.rows[0]!) };
      } catch {
        return internal("Failed to archive library");
      }
    },

    async listMembers(orgId, libraryId) {
      try {
        const r = await executor.execute<Row>(
          `SELECT * FROM media_library_members WHERE org_id = $1 AND library_id = $2 ORDER BY created_at ASC, principal_id ASC`,
          [orgId, libraryId],
        );
        return { ok: true, value: r.rows.map(mapMember) };
      } catch {
        return internal("Failed to list members");
      }
    },

    async listPrincipalRoles(orgId, principalId) {
      try {
        const r = await executor.execute<Row>(
          `SELECT m.* FROM media_library_members m
             JOIN media_libraries l ON l.org_id = m.org_id AND l.id = m.library_id
           WHERE m.org_id = $1 AND m.principal_id = $2 AND l.status = 'active'`,
          [orgId, principalId],
        );
        return { ok: true, value: r.rows.map(mapMember) };
      } catch {
        return internal("Failed to list principal roles");
      }
    },

    async listGuestMemberships(principalId) {
      try {
        const r = await executor.execute<Row>(
          `SELECT m.* FROM media_library_members m
             JOIN media_libraries l ON l.org_id = m.org_id AND l.id = m.library_id
           WHERE m.principal_id = $1 AND m.principal_kind = 'guest' AND l.status = 'active'
           ORDER BY m.created_at ASC`,
          [principalId],
        );
        return { ok: true, value: r.rows.map(mapMember) };
      } catch {
        return internal("Failed to list guest memberships");
      }
    },

    async upsertMember(input: UpsertMemberInput) {
      const at = input.at.toISOString();
      try {
        const r = await executor.execute<Row>(
          `INSERT INTO media_library_members
             (org_id, library_id, principal_kind, principal_id, email, role, created_by, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $8)
           ON CONFLICT (org_id, library_id, principal_id)
           DO UPDATE SET role = excluded.role, principal_kind = excluded.principal_kind,
                         email = COALESCE(excluded.email, media_library_members.email), updated_at = excluded.updated_at
           RETURNING *`,
          [input.orgId, input.libraryId, input.principalKind, input.principalId, input.email, input.role, input.createdBy, at],
        );
        return { ok: true, value: mapMember(r.rows[0]!) };
      } catch {
        return internal("Failed to upsert member");
      }
    },

    async removeMember(orgId, libraryId, principalId) {
      try {
        const r = await executor.execute<Row>(
          `DELETE FROM media_library_members WHERE org_id = $1 AND library_id = $2 AND principal_id = $3 RETURNING principal_id`,
          [orgId, libraryId, principalId],
        );
        return r.rowCount === 0 ? notFound() : { ok: true, value: true };
      } catch {
        return internal("Failed to remove member");
      }
    },

    async countManagers(orgId, libraryId) {
      try {
        const r = await executor.execute<Row>(
          `SELECT COUNT(*) AS n FROM media_library_members WHERE org_id = $1 AND library_id = $2 AND role = 'manager'`,
          [orgId, libraryId],
        );
        return { ok: true, value: Number(r.rows[0]?.n ?? 0) };
      } catch {
        return internal("Failed to count managers");
      }
    },

    async createInvitation(input: CreateInvitationInput) {
      try {
        const r = await executor.execute<Row>(
          `INSERT INTO media_library_invitations
             (id, org_id, library_id, email_lower, role, created_by, created_at, updated_at, expires_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $7, $8) RETURNING *`,
          [
            input.id,
            input.orgId,
            input.libraryId,
            input.emailLower,
            input.role,
            input.createdBy,
            input.createdAt.toISOString(),
            input.expiresAt.toISOString(),
          ],
        );
        return { ok: true, value: mapInvitation(r.rows[0]!) };
      } catch (err) {
        if (isUniqueViolation(err)) return { ok: false, error: { kind: "conflict", entity: "invitation" } };
        return internal("Failed to create invitation");
      }
    },

    async listOpenInvitations(orgId, libraryId, now) {
      try {
        const r = await executor.execute<Row>(
          `SELECT * FROM media_library_invitations
           WHERE org_id = $1 AND library_id = $2 AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > $3
           ORDER BY created_at ASC`,
          [orgId, libraryId, now.toISOString()],
        );
        return { ok: true, value: r.rows.map(mapInvitation) };
      } catch {
        return internal("Failed to list invitations");
      }
    },

    async revokeInvitation(orgId, libraryId, invitationId, at) {
      try {
        const r = await executor.execute<Row>(
          `UPDATE media_library_invitations SET revoked_at = $4, updated_at = $4
           WHERE org_id = $1 AND library_id = $2 AND id = $3 AND accepted_at IS NULL AND revoked_at IS NULL
           RETURNING id`,
          [orgId, libraryId, invitationId, at.toISOString()],
        );
        return r.rowCount === 0 ? notFound() : { ok: true, value: true };
      } catch {
        return internal("Failed to revoke invitation");
      }
    },

    async listInvitationsForEmail(emailLower, now) {
      try {
        const r = await executor.execute<Row>(
          `SELECT i.* FROM media_library_invitations i
             JOIN media_libraries l ON l.org_id = i.org_id AND l.id = i.library_id
           WHERE i.email_lower = $1 AND i.accepted_at IS NULL AND i.revoked_at IS NULL AND i.expires_at > $2
             AND l.status = 'active'
           ORDER BY i.created_at ASC`,
          [emailLower, now.toISOString()],
        );
        return { ok: true, value: r.rows.map(mapInvitation) };
      } catch {
        return internal("Failed to list invitations for email");
      }
    },

    async acceptInvitation(invitation: LibraryInvitation, principalId: string, at: Date) {
      const ts = at.toISOString();
      try {
        // Accept only if still open; the member insert never downgrades an existing (member-kind) row.
        const [accepted] = await executeBatch(executor, [
          {
            text: `UPDATE media_library_invitations SET accepted_at = $4, accepted_by = $5, updated_at = $4
                   WHERE org_id = $1 AND library_id = $2 AND id = $3 AND accepted_at IS NULL AND revoked_at IS NULL
                   RETURNING id`,
            params: [invitation.orgId, invitation.libraryId, invitation.id, ts, principalId],
          },
          {
            text: `INSERT INTO media_library_members
                     (org_id, library_id, principal_kind, principal_id, email, role, created_by, created_at, updated_at)
                   SELECT $1, $2, 'guest', $3, $4, $5, $6, $7, $7
                   WHERE EXISTS (SELECT 1 FROM media_library_invitations
                                 WHERE org_id = $1 AND library_id = $2 AND id = $8 AND accepted_by = $3)
                   ON CONFLICT (org_id, library_id, principal_id) DO NOTHING`,
            params: [
              invitation.orgId,
              invitation.libraryId,
              principalId,
              invitation.emailLower,
              invitation.role,
              invitation.createdBy,
              ts,
              invitation.id,
            ],
          },
        ]);
        if (!accepted || accepted.rowCount === 0) return notFound();
        const r = await executor.execute<Row>(
          `SELECT * FROM media_library_members WHERE org_id = $1 AND library_id = $2 AND principal_id = $3`,
          [invitation.orgId, invitation.libraryId, principalId],
        );
        return r.rowCount === 0 ? notFound() : { ok: true, value: mapMember(r.rows[0]!) };
      } catch {
        return internal("Failed to accept invitation");
      }
    },

    async setServingIdentity(orgId, libraryId, orgSlug, signingKey, at) {
      try {
        const r = await executor.execute<Row>(
          `UPDATE media_libraries SET org_slug = COALESCE(org_slug, $3), signing_key = COALESCE(signing_key, $4), updated_at = $5
           WHERE org_id = $1 AND id = $2 RETURNING *`,
          [orgId, libraryId, orgSlug, signingKey, at.toISOString()],
        );
        return r.rowCount === 0 ? notFound() : { ok: true, value: mapLibrary(r.rows[0]!) };
      } catch {
        return internal("Failed to set serving identity");
      }
    },

    async getUsage(orgId, month) {
      try {
        const r = await executor.execute<Row>(
          `SELECT period, uploads, upload_bytes, storage_bytes FROM media_usage WHERE org_id = $1 AND period IN ('total', $2)`,
          [orgId, month],
        );
        const usage: OrgUsage = { storageBytes: 0, uploadsThisMonth: 0, uploadBytesThisMonth: 0 };
        for (const row of r.rows) {
          if (row.period === "total") usage.storageBytes = Number(row.storage_bytes);
          else {
            usage.uploadsThisMonth = Number(row.uploads);
            usage.uploadBytesThisMonth = Number(row.upload_bytes);
          }
        }
        return { ok: true, value: usage };
      } catch {
        return internal("Failed to read usage");
      }
    },

    async getLimitOverrides(orgId) {
      try {
        const r = await executor.execute<Row>(`SELECT * FROM media_org_limits WHERE org_id = $1`, [orgId]);
        if (r.rowCount === 0) return { ok: true, value: null };
        const row = r.rows[0]!;
        const n = (v: unknown) => (v === null || v === undefined ? null : Number(v));
        const value: OrgLimitOverrides = {
          storageBytesLimit: n(row.storage_bytes_limit),
          uploadsPerMonthLimit: n(row.uploads_per_month_limit),
          maxFileBytes: n(row.max_file_bytes),
        };
        return { ok: true, value };
      } catch {
        return internal("Failed to read limits");
      }
    },

    async recordUpload(orgId, month, bytes, storedBytes, at) {
      const ts = at.toISOString();
      try {
        await executeBatch(executor, [
          {
            text: `INSERT INTO media_usage (org_id, period, uploads, upload_bytes, created_at, updated_at)
                   VALUES ($1, $2, 1, $3, $4, $4)
                   ON CONFLICT (org_id, period) DO UPDATE SET uploads = uploads + 1,
                     upload_bytes = upload_bytes + excluded.upload_bytes, updated_at = excluded.updated_at`,
            params: [orgId, month, bytes, ts],
          },
          {
            text: `INSERT INTO media_usage (org_id, period, storage_bytes, created_at, updated_at)
                   VALUES ($1, 'total', $2, $3, $3)
                   ON CONFLICT (org_id, period) DO UPDATE SET storage_bytes = storage_bytes + excluded.storage_bytes,
                     updated_at = excluded.updated_at`,
            params: [orgId, storedBytes, ts],
          },
        ]);
        return { ok: true, value: true };
      } catch {
        return internal("Failed to record upload");
      }
    },

    async releaseStorage(orgId, bytes, at) {
      try {
        await executor.execute(
          `UPDATE media_usage SET storage_bytes = MAX(0, storage_bytes - $2), updated_at = $3
           WHERE org_id = $1 AND period = 'total'`,
          [orgId, bytes, at.toISOString()],
        );
        return { ok: true, value: true };
      } catch {
        return internal("Failed to release storage");
      }
    },

    async addStorage(orgId, bytes, at) {
      try {
        await executor.execute(
          `INSERT INTO media_usage (org_id, period, storage_bytes, created_at, updated_at) VALUES ($1, 'total', $2, $3, $3)
           ON CONFLICT (org_id, period) DO UPDATE SET storage_bytes = media_usage.storage_bytes + excluded.storage_bytes,
             updated_at = excluded.updated_at`,
          [orgId, bytes, at.toISOString()],
        );
        return { ok: true, value: true };
      } catch {
        return internal("Failed to add storage");
      }
    },

    async orgIsOnFreePlan(orgId) {
      try {
        const r = await executor.execute<Row>(
          `SELECT 1 AS paid FROM billing_subscriptions s JOIN billing_plans p ON p.id = s.plan_id
           WHERE s.org_id = $1 AND s.status IN ('active', 'trialing') AND COALESCE(p.price_amount_cents, 0) > 0 LIMIT 1`,
          [orgId],
        );
        return { ok: true, value: r.rowCount === 0 };
      } catch {
        return internal("Failed to read the org's plan");
      }
    },

    async recordPipelineFailure(input) {
      try {
        await executor.execute(
          `INSERT INTO media_pipeline_failures (id, org_id, library_id, file_id, sha256, step, error_name, status, created_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, 'open', $8)`,
          [crypto.randomUUID(), input.orgId, input.libraryId, input.fileId, input.sha256, input.step.slice(0, 40), input.errorName.slice(0, 80), input.at.toISOString()],
        );
        return { ok: true, value: true };
      } catch {
        return internal("Failed to record the pipeline failure");
      }
    },

    async listPipelineFailures(filter) {
      try {
        const where: string[] = [];
        const params: unknown[] = [];
        const add = (column: string, v: unknown) => {
          params.push(v);
          where.push(`${column} = $${params.length}`);
        };
        if (filter.orgId) add("org_id", filter.orgId);
        if (filter.libraryId) add("library_id", filter.libraryId);
        if (filter.status) add("status", filter.status);
        params.push(Math.min(200, Math.max(1, filter.limit)));
        const r = await executor.execute<Row>(
          `SELECT * FROM media_pipeline_failures ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY created_at DESC LIMIT $${params.length}`,
          params,
        );
        return {
          ok: true,
          value: r.rows.map((row) => ({
            id: String(row.id),
            orgId: String(row.org_id),
            libraryId: String(row.library_id),
            fileId: String(row.file_id),
            sha256: String(row.sha256),
            step: String(row.step),
            errorName: String(row.error_name),
            status: row.status as PipelineFailure["status"],
            createdAt: String(row.created_at),
            resolvedAt: row.resolved_at == null ? null : String(row.resolved_at),
          })),
        };
      } catch {
        return internal("Failed to list pipeline failures");
      }
    },

    async settlePipelineFailures(orgId, libraryId, fileId, status, at) {
      try {
        await executor.execute(
          `UPDATE media_pipeline_failures SET status = $4, resolved_at = $5 WHERE org_id = $1 AND library_id = $2 AND file_id = $3 AND status = 'open'`,
          [orgId, libraryId, fileId, status, at.toISOString()],
        );
        return { ok: true, value: true };
      } catch {
        return internal("Failed to update pipeline failures");
      }
    },

    async reportAbuse(input) {
      try {
        const open = await executor.execute<Row>(
          `SELECT id FROM media_abuse_cases WHERE org_id = $1 AND library_id = $2 AND file_ref = $3 AND status = 'open' LIMIT 1`,
          [input.orgId, input.libraryId, input.fileId],
        );
        if (open.rowCount > 0) {
          const id = String(open.rows[0]!.id);
          await executor.execute(`UPDATE media_abuse_cases SET report_count = report_count + 1, updated_at = $2 WHERE id = $1`, [id, input.at.toISOString()]);
          return { ok: true, value: { caseId: id, created: false } };
        }
        const id = crypto.randomUUID();
        await executor.execute(
          `INSERT INTO media_abuse_cases (id, org_id, library_id, file_ref, sha256, reason, details, reporter_email, report_count, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 1, $9, $9)`,
          [id, input.orgId, input.libraryId, input.fileId, input.sha256, input.category, input.details, input.reporterEmail, input.at.toISOString()],
        );
        return { ok: true, value: { caseId: id, created: true } };
      } catch {
        return internal("Failed to record the report");
      }
    },

    async listAbuseCases(filter) {
      try {
        const r = filter.status
          ? await executor.execute<Row>(`SELECT * FROM media_abuse_cases WHERE status = $1 ORDER BY created_at DESC LIMIT $2`, [filter.status, Math.min(200, Math.max(1, filter.limit))])
          : await executor.execute<Row>(`SELECT * FROM media_abuse_cases ORDER BY created_at DESC LIMIT $1`, [Math.min(200, Math.max(1, filter.limit))]);
        return { ok: true, value: r.rows.map(toAbuseCase) };
      } catch {
        return internal("Failed to list abuse cases");
      }
    },

    async getAbuseCase(id) {
      try {
        const r = await executor.execute<Row>(`SELECT * FROM media_abuse_cases WHERE id = $1`, [id]);
        return r.rowCount === 0 ? notFound() : { ok: true, value: toAbuseCase(r.rows[0]!) };
      } catch {
        return internal("Failed to read the abuse case");
      }
    },

    async decideAbuseCase(id, status, decidedBy, note, at) {
      try {
        await executor.execute(
          `UPDATE media_abuse_cases SET status = $2, handled_by = $3, decision_note = $4, action = $6, handled_at = $5, updated_at = $5 WHERE id = $1`,
          [id, status, decidedBy, note, at.toISOString(), status === "actioned" ? "takedown" : "dismiss"],
        );
        const r = await executor.execute<Row>(`SELECT * FROM media_abuse_cases WHERE id = $1`, [id]);
        return r.rowCount === 0 ? notFound() : { ok: true, value: toAbuseCase(r.rows[0]!) };
      } catch {
        return internal("Failed to decide the abuse case");
      }
    },

    async isPlatformOperator(subjectId) {
      try {
        const r = await executor.execute<Row>(`SELECT 1 AS ok FROM platform_media_operators WHERE subject_id = $1`, [subjectId]);
        return { ok: true, value: r.rowCount > 0 };
      } catch {
        return internal("Failed to read operators");
      }
    },

    async userEmails(userIds) {
      try {
        const ids = [...new Set(userIds)].slice(0, 50);
        if (!ids.length) return { ok: true, value: new Map() };
        const r = await executor.execute<Row>(
          `SELECT id, email FROM identity_users WHERE id IN (` + ids.map((_, i) => `$` + (i + 1)).join(", ") + `)`,
          ids,
        );
        return { ok: true, value: new Map(r.rows.map((row) => [String(row.id), String(row.email)])) };
      } catch {
        return internal("Failed to read user emails");
      }
    },

    async createUploadLink(input) {
      try {
        const id = crypto.randomUUID();
        const r = await executor.execute<Row>(
          `INSERT INTO media_upload_links (id, org_id, library_id, folder_path, label, token_hash, limits_json, requires_review, created_by,
             expires_at, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $11) RETURNING *`,
          [id, input.orgId, input.libraryId, input.folderPath, input.label, input.tokenHash, JSON.stringify(input.limits), input.requiresReview ? 1 : 0,
            input.createdBy, input.expiresAt ? input.expiresAt.toISOString() : null, input.at.toISOString()],
        );
        return { ok: true, value: toUploadLink(r.rows[0]!) };
      } catch {
        return internal("Failed to create the upload link");
      }
    },

    async listUploadLinks(orgId, libraryId, limit) {
      try {
        const r = await executor.execute<Row>(
          `SELECT * FROM media_upload_links WHERE org_id = $1 AND library_id = $2 ORDER BY created_at DESC LIMIT $3`,
          [orgId, libraryId, Math.min(200, Math.max(1, limit))],
        );
        return { ok: true, value: r.rows.map(toUploadLink) };
      } catch {
        return internal("Failed to list upload links");
      }
    },

    async getUploadLinkByTokenHash(tokenHash) {
      try {
        const r = await executor.execute<Row>(`SELECT * FROM media_upload_links WHERE token_hash = $1`, [tokenHash]);
        if (r.rowCount === 0) return { ok: false, error: { kind: "not_found", entity: "upload_link" } };
        return { ok: true, value: toUploadLink(r.rows[0]!) };
      } catch {
        return internal("Failed to read the upload link");
      }
    },

    async revokeUploadLink(orgId, libraryId, id, at) {
      try {
        const r = await executor.execute<Row>(
          `UPDATE media_upload_links SET revoked_at = COALESCE(revoked_at, $4), updated_at = $4 WHERE id = $1 AND org_id = $2 AND library_id = $3 RETURNING *`,
          [id, orgId, libraryId, at.toISOString()],
        );
        if (r.rowCount === 0) return { ok: false, error: { kind: "not_found", entity: "upload_link" } };
        return { ok: true, value: toUploadLink(r.rows[0]!) };
      } catch {
        return internal("Failed to revoke the upload link");
      }
    },

    async reserveUpload(link, bytes, at) {
      try {
        const r = await executor.execute<Row>(
          `UPDATE media_upload_links SET uploads = uploads + 1, bytes = bytes + $2, updated_at = $3
           WHERE id = $1 AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > $3)
             AND uploads < $4 AND bytes + $2 <= $5 RETURNING id`,
          [link.id, bytes, at.toISOString(), link.limits.maxFiles, link.limits.maxTotalBytes],
        );
        return { ok: true, value: r.rowCount > 0 };
      } catch {
        return internal("Failed to reserve the upload");
      }
    },

    async releaseUpload(id, bytes) {
      try {
        await executor.execute(
          `UPDATE media_upload_links SET uploads = MAX(uploads - 1, 0), bytes = MAX(bytes - $2, 0) WHERE id = $1`,
          [id, bytes],
        );
        return { ok: true, value: true };
      } catch {
        return internal("Failed to release the upload");
      }
    },

    async createShareLink(input) {
      try {
        const id = crypto.randomUUID();
        const r = await executor.execute<Row>(
          `INSERT INTO media_share_links (id, org_id, library_id, target_kind, target_id, target_label, mode, token_hash, password_hash,
             expires_at, max_downloads, created_by, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $13) RETURNING *`,
          [id, input.orgId, input.libraryId, input.targetKind, input.targetId, input.targetLabel, input.mode, input.tokenHash, input.passwordHash,
            input.expiresAt ? input.expiresAt.toISOString() : null, input.maxDownloads, input.createdBy, input.at.toISOString()],
        );
        return { ok: true, value: toShareLink(r.rows[0]!) };
      } catch {
        return internal("Failed to create the share link");
      }
    },

    async listShareLinks(orgId, libraryId, filter) {
      try {
        const where = [`org_id = $1`, `library_id = $2`];
        const params: unknown[] = [orgId, libraryId];
        if (filter.targetKind) {
          params.push(filter.targetKind);
          where.push(`target_kind = $` + params.length);
        }
        if (filter.targetId) {
          params.push(filter.targetId);
          where.push(`target_id = $` + params.length);
        }
        params.push(Math.min(200, Math.max(1, filter.limit)));
        const r = await executor.execute<Row>(`SELECT * FROM media_share_links WHERE ` + where.join(" AND ") + ` ORDER BY created_at DESC LIMIT $` + params.length, params);
        return { ok: true, value: r.rows.map(toShareLink) };
      } catch {
        return internal("Failed to list share links");
      }
    },

    async getShareLink(orgId, libraryId, id) {
      try {
        const r = await executor.execute<Row>(`SELECT * FROM media_share_links WHERE id = $1 AND org_id = $2 AND library_id = $3`, [id, orgId, libraryId]);
        if (r.rowCount === 0) return { ok: false, error: { kind: "not_found", entity: "share_link" } };
        return { ok: true, value: toShareLink(r.rows[0]!) };
      } catch {
        return internal("Failed to read the share link");
      }
    },

    async getShareLinkByTokenHash(tokenHash) {
      try {
        const r = await executor.execute<Row>(`SELECT * FROM media_share_links WHERE token_hash = $1`, [tokenHash]);
        if (r.rowCount === 0) return { ok: false, error: { kind: "not_found", entity: "share_link" } };
        return { ok: true, value: toShareLink(r.rows[0]!) };
      } catch {
        return internal("Failed to read the share link");
      }
    },

    async revokeShareLink(orgId, libraryId, id, at) {
      try {
        const r = await executor.execute<Row>(
          `UPDATE media_share_links SET revoked_at = COALESCE(revoked_at, $4), updated_at = $4 WHERE id = $1 AND org_id = $2 AND library_id = $3 RETURNING *`,
          [id, orgId, libraryId, at.toISOString()],
        );
        if (r.rowCount === 0) return { ok: false, error: { kind: "not_found", entity: "share_link" } };
        return { ok: true, value: toShareLink(r.rows[0]!) };
      } catch {
        return internal("Failed to revoke the share link");
      }
    },

    async recordShareOpen(id, at) {
      try {
        await executor.execute(`UPDATE media_share_links SET opens = opens + 1, last_opened_at = $2 WHERE id = $1`, [id, at.toISOString()]);
        return { ok: true, value: true };
      } catch {
        return internal("Failed to record the open");
      }
    },

    async consumeShareDownload(id, at) {
      try {
        const r = await executor.execute<Row>(
          `UPDATE media_share_links SET downloads = downloads + 1, updated_at = $2
           WHERE id = $1 AND revoked_at IS NULL AND (max_downloads IS NULL OR downloads < max_downloads) RETURNING id`,
          [id, at.toISOString()],
        );
        return { ok: true, value: r.rowCount > 0 };
      } catch {
        return internal("Failed to count the download");
      }
    },

    async getOrgSuspension(orgId) {
      try {
        const r = await executor.execute<Row>(`SELECT suspended_at, reason FROM media_org_status WHERE org_id = $1 AND suspended_at IS NOT NULL`, [orgId]);
        if (r.rowCount === 0) return { ok: true, value: null };
        const row = r.rows[0]!;
        return { ok: true, value: { suspendedAt: String(row.suspended_at), reason: row.reason == null ? null : String(row.reason) } };
      } catch {
        return internal("Failed to read the org's status");
      }
    },

    async setOrgSuspension(orgId, suspended, reason, decidedBy, at) {
      try {
        await executor.execute(
          `INSERT INTO media_org_status (org_id, suspended_at, reason, decided_by, updated_at) VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT (org_id) DO UPDATE SET suspended_at = excluded.suspended_at, reason = excluded.reason,
             decided_by = excluded.decided_by, updated_at = excluded.updated_at`,
          [orgId, suspended ? at.toISOString() : null, reason, decidedBy, at.toISOString()],
        );
        return { ok: true, value: true };
      } catch {
        return internal("Failed to update the org's status");
      }
    },

    async getStorageBackend(orgId, libraryId) {
      try {
        const r = await executor.execute<Row>(
          `SELECT * FROM media_storage_backends WHERE org_id = $1 AND library_id = $2 AND status != 'retired'
           ORDER BY created_at DESC LIMIT 1`,
          [orgId, libraryId],
        );
        if (r.rowCount === 0) return notFound();
        const row = r.rows[0]!;
        const value: StorageBackend = {
          id: row.id as string,
          orgId: row.org_id as string,
          libraryId: row.library_id as string,
          kind: row.kind as StorageBackend["kind"],
          prefix: row.prefix as string,
          status: row.status as string,
        };
        return { ok: true, value };
      } catch {
        return internal("Failed to get storage backend");
      }
    },
  };
}

function toAbuseCase(row: Record<string, unknown>): AbuseCase {
  const str = (v: unknown) => (v == null ? null : String(v));
  return {
    id: String(row.id),
    orgId: String(row.org_id),
    libraryId: String(row.library_id),
    fileId: String(row.file_ref),
    sha256: String(row.sha256 ?? ""),
    category: row.reason as AbuseCase["category"],
    details: str(row.details),
    reporterEmail: str(row.reporter_email),
    reportCount: Number(row.report_count ?? 1),
    status: row.status as AbuseCase["status"],
    decidedBy: str(row.handled_by),
    decisionNote: str(row.decision_note),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}
