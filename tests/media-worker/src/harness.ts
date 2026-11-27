// A real media-worker over a real SQLite D1 (every migration applied), with fakes only at the service-binding
// seams: membership (who holds which org role), projects (creates the project row), and policy, which calls the
// REAL policy engine, so every decision in these tests is the one policy-worker would make.

import { DatabaseSync } from "node:sqlite";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { D1ApiAdapter } from "@saas/db/runner";
import type { D1Binding } from "@saas/db/d1";
import { uuidToHex } from "@saas/db/ids";
import { authorize } from "@saas/policy-engine";
import type { AuthorizationRequest, MembershipFact } from "@saas/contracts/policy";
import type { TenancyRole } from "@saas/contracts/tenancy";
import { route } from "@media-worker/router";
import type { Env } from "@media-worker/env";

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_ROOT = resolve(__dirname, "../../..", "packages/db/src/migrations");

export function migratedDatabase(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  const dirs = readdirSync(MIGRATIONS_ROOT)
    .filter((d) => existsSync(join(MIGRATIONS_ROOT, d, "up.sql")))
    .sort();
  for (const dir of dirs) {
    const sql = readFileSync(join(MIGRATIONS_ROOT, dir, "up.sql"), "utf8");
    for (const statement of D1ApiAdapter.splitStatements(sql)) db.exec(statement);
  }
  return db;
}

export function d1Over(db: DatabaseSync): D1Binding {
  return {
    prepare(query: string) {
      let bound: unknown[] = [];
      const statement = {
        bind(...values: unknown[]) {
          bound = values;
          return statement;
        },
        all<T>() {
          const rows = db.prepare(query).all(...(bound as never[])) as T[];
          return Promise.resolve({ results: rows, success: true });
        },
      };
      return statement;
    },
    async batch(statements: Array<{ all(): Promise<unknown> }>) {
      db.exec("BEGIN");
      try {
        const results = [];
        for (const s of statements) results.push(await s.all());
        db.exec("COMMIT");
        return results;
      } catch (err) {
        db.exec("ROLLBACK");
        throw err;
      }
    },
  } as unknown as D1Binding;
}

export const pub = (prefix: string, uuid: string) => `${prefix}_${uuidToHex(uuid)}`;

export interface User {
  id: string; // usr_<hex>, as the edge forwards it
  email: string;
}

export class World {
  readonly db = migratedDatabase();
  /** orgUuid → subjectId → org roles */
  readonly orgRoles = new Map<string, Map<string, TenancyRole[]>>();
  readonly policyCalls: AuthorizationRequest[] = [];
  readonly env: Env;
  now = new Date("2026-11-27T10:00:00.000Z");

  constructor() {
    const self = this;
    const json = (data: unknown, status = 200) =>
      new Response(JSON.stringify({ data, meta: { requestId: "req_test" } }), {
        status,
        headers: { "content-type": "application/json" },
      });
    const fetcher = (fn: (req: Request) => Promise<Response>): Fetcher =>
      ({ fetch: (input: RequestInfo, init?: RequestInit) => fn(new Request(input as string, init)) }) as unknown as Fetcher;

    this.env = {
      ENVIRONMENT: "test",
      PLATFORM_DB: d1Over(this.db) as unknown as D1Database,
      MEMBERSHIP_WORKER: fetcher(async (req) => {
        const body = (await req.json()) as { subject: { id: string }; orgId: string };
        const roles = self.orgRoles.get(body.orgId)?.get(body.subject.id) ?? [];
        const memberships: MembershipFact[] = roles.map((role) => ({
          kind: "role_assignment",
          role,
          scope: { kind: "organization", orgId: body.orgId },
        }));
        return json({ memberships });
      }),
      POLICY_WORKER: fetcher(async (req) => {
        const body = (await req.json()) as AuthorizationRequest;
        self.policyCalls.push(body);
        return json(authorize(body));
      }),
      PROJECTS_WORKER: fetcher(async (req) => {
        const url = new URL(req.url);
        const m = url.pathname.match(/^\/v1\/organizations\/org_([0-9a-f]{32})\/projects(?:\/prj_([0-9a-f]{32}))?$/);
        if (!m) return json(null, 404);
        const orgHex = m[1]!;
        const orgId = `${orgHex.slice(0, 8)}-${orgHex.slice(8, 12)}-${orgHex.slice(12, 16)}-${orgHex.slice(16, 20)}-${orgHex.slice(20)}`;
        const actor = req.headers.get("x-actor-subject-id")!;
        const roles = self.orgRoles.get(orgId)?.get(actor) ?? [];
        if (req.method === "DELETE") return json({ project: { id: `prj_${m[2]}` } });
        const allowed = authorize({
          subject: { type: "user", id: actor },
          action: "project.create",
          resource: { kind: "project", orgId },
          context: { memberships: roles.map((role) => ({ kind: "role_assignment", role, scope: { kind: "organization", orgId } })) },
        }).allow;
        if (!allowed) return json(null, 404);
        const { name, slug } = (await req.json()) as { name: string; slug: string };
        const taken = self.db.prepare(`SELECT 1 FROM projects_projects WHERE org_id = ? AND slug_lower = ?`).get(orgId, slug);
        if (taken) return json(null, 409);
        const id = crypto.randomUUID();
        self.db
          .prepare(`INSERT INTO projects_projects (id, org_id, name, slug, slug_lower) VALUES (?, ?, ?, ?, ?)`)
          .run(id, orgId, name, slug, slug);
        return json({ project: { id: pub("prj", id) } }, 201);
      }),
    };
  }

  newOrg(): { id: string; pub: string } {
    const id = crypto.randomUUID();
    this.orgRoles.set(id, new Map());
    return { id, pub: pub("org", id) };
  }

  newUser(name: string): User {
    return { id: pub("usr", crypto.randomUUID()), email: `${name}@example.test` };
  }

  grant(org: { id: string }, user: User, role: TenancyRole): void {
    this.orgRoles.get(org.id)!.set(user.id, [role]);
  }

  async call(user: User | null, method: string, path: string, body?: unknown): Promise<{ status: number; json: any }> {
    const headers = new Headers({ "content-type": "application/json", "x-request-id": "req_test" });
    if (user) {
      headers.set("x-actor-subject-id", user.id);
      headers.set("x-actor-subject-type", "user");
      headers.set("x-actor-email", user.email);
    }
    const req = new Request(`https://media.internal${path}`, {
      method,
      headers,
      body: body === undefined ? null : JSON.stringify(body),
    });
    const res = await route(req, this.env, { now: () => this.now });
    const text = await res.text();
    return { status: res.status, json: text ? JSON.parse(text) : null };
  }
}
