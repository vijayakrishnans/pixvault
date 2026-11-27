import type { SqlExecutor, SqlStatement } from "../d1/executor.js";
import { executeBatch } from "../d1/executor.js";
import { isUniqueViolation } from "../d1/errors.js";
import type {
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
                    created_by, created_at, updated_at)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $10)`,
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
