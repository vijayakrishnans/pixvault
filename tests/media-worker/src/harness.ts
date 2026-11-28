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
  readonly bucket = new FakeBucket();
  readonly index = new FakeIndexNamespace();
  readonly kv = new Map<string, string>();
  readonly orgSlugs = new Map<string, string>();
  /** ProcessFileWorkflow runs started (PV4); `runPipelines()` executes them. */
  readonly workflows: { id: string; params: PipelineParams }[] = [];
  /** What the moderation model answers next (its raw text), or an error it throws. */
  aiVerdict: string | Error = '```json\n{"verdict":"safe","categories":[]}\n```';
  readonly aiCalls: { model: string }[] = [];
  /** Emails queued with notifications-worker (mentions, PV6). */
  readonly notifications: { headers: Record<string, string>; body: any }[] = [];
  /** Make the next Workflow create calls fail (a lost start). */
  failWorkflowStarts = false;
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
      MEDIA_BUCKET: this.bucket as unknown as R2Bucket,
      LIBRARY_INDEX: this.index as unknown as DurableObjectNamespace,
      ROUTES_KV: {
        get: async (k: string) => self.kv.get(k) ?? null,
        put: async (k: string, v: string) => void self.kv.set(k, v),
        delete: async (k: string) => void self.kv.delete(k),
      } as unknown as KVNamespace,
      SERVE_BASE: "https://serve.test",
      APP_BASE: "https://app.test",
      NOTIFICATIONS_WORKER: fetcher(async (req) => {
        self.notifications.push({ headers: Object.fromEntries(req.headers), body: await req.json() });
        return json({ notificationId: `ntf_${self.notifications.length}`, outcome: "created" }, 201);
      }),
      PROCESS_FILE: {
        create: async ({ id, params }: { id: string; params: PipelineParams }) => {
          if (self.failWorkflowStarts) throw new Error("workflow create failed");
          if (self.workflows.some((w) => w.id === id)) throw new Error("instance already exists");
          self.workflows.push({ id, params });
          return { id };
        },
      } as unknown as Workflow<PipelineParams>,
      IMAGES: {
        info: async (stream: ReadableStream) => {
          await new Response(stream).arrayBuffer();
          return { format: "image/jpeg", fileSize: 1, width: 32, height: 24 };
        },
        input(stream: ReadableStream) {
          const chain = {
            transform: () => chain,
            output: async () => {
              await new Response(stream).arrayBuffer();
              return { response: () => new Response(new Uint8Array([0xff, 0xd8, 0xff, 0xdb, 1, 2, 3, 0xff, 0xd9])) };
            },
          };
          return chain;
        },
      } as unknown as ImagesBinding,
      AI: {
        run: async (model: string) => {
          self.aiCalls.push({ model });
          if (model.includes("resnet")) return [{ label: "Tabby Cat", score: 0.91 }, { label: "Lynx", score: 0.42 }, { label: "Parachute", score: 0.12 }];
          if (self.aiVerdict instanceof Error) throw self.aiVerdict;
          return { response: self.aiVerdict };
        },
      } as unknown as Ai,
      MODERATION_MODEL: "@cf/test/moderation",
      TAGS_MODEL: "@cf/test/resnet",
      MEMBERSHIP_WORKER: fetcher(async (req) => {
        if (req.method === "GET") {
          // GET /v1/organizations/org_<hex>: the org, for its members only (as membership-worker does).
          const m = new URL(req.url).pathname.match(/^\/v1\/organizations\/org_([0-9a-f]{32})$/);
          if (!m) return json(null, 404);
          const h = m[1]!;
          const orgId = `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
          const actor = req.headers.get("x-actor-subject-id") ?? "";
          if (!(self.orgRoles.get(orgId)?.get(actor)?.length)) return json(null, 404);
          return json({ organization: { id: `org_${h}`, slug: self.orgSlugs.get(orgId), name: "Org" } });
        }
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

  newOrg(): { id: string; pub: string; slug: string } {
    const id = crypto.randomUUID();
    this.orgRoles.set(id, new Map());
    const slug = `team-${id.slice(0, 8)}`;
    this.orgSlugs.set(id, slug);
    return { id, pub: pub("org", id), slug };
  }

  /**
   * Run the pipeline for every Workflow started so far (and any they start), with Workflows' step retries.
   * Returns each run's result.
   */
  async runPipelines(): Promise<string[]> {
    const out: string[] = [];
    const step: Step = {
      async do<T>(_name: string, config: StepConfig, fn: () => Promise<T>): Promise<T> {
        const limit = config.retries?.limit ?? 0;
        for (let attempt = 0; ; attempt++) {
          try {
            return await fn();
          } catch (e) {
            if (attempt >= limit) throw e;
          }
        }
      },
    };
    while (this.ranWorkflows < this.workflows.length) {
      const w = this.workflows[this.ranWorkflows++]!;
      out.push(await runPipeline(this.env, w.params, step, () => this.now));
    }
    return out;
  }
  private ranWorkflows = 0;

  /** Run every library index's outbox drain into the fake KV, as the Durable Object's alarm does. */
  async drain(): Promise<number> {
    let n = 0;
    for (const [name, core] of this.index.cores) {
      const libraryId = name.split(":lib:")[1]!;
      n += await drainOutbox(core, { put: async (k, v) => void this.kv.set(k, v), delete: async (k) => void this.kv.delete(k) }, libraryId);
    }
    return n;
  }

  newUser(name: string): User {
    return { id: pub("usr", crypto.randomUUID()), email: `${name}@example.test` };
  }

  grant(org: { id: string }, user: User, role: TenancyRole): void {
    this.orgRoles.get(org.id)!.set(user.id, [role]);
  }

  /** Send raw bytes (an upload part). */
  async put(user: User, path: string, bytes: Uint8Array): Promise<{ status: number; json: any }> {
    const headers = new Headers({ "x-request-id": "req_test", "x-actor-subject-id": user.id, "x-actor-subject-type": "user", "x-actor-email": user.email });
    const res = await route(new Request(`https://media.internal${path}`, { method: "PUT", headers, body: bytes }), this.env, { now: () => this.now });
    const text = await res.text();
    return { status: res.status, json: text ? JSON.parse(text) : null };
  }

  /** GET raw bytes (file content). */
  async bytes(user: User, path: string): Promise<{ status: number; bytes: Uint8Array; headers: Headers }> {
    const headers = new Headers({ "x-request-id": "req_test", "x-actor-subject-id": user.id, "x-actor-subject-type": "user", "x-actor-email": user.email });
    const res = await route(new Request(`https://media.internal${path}`, { headers }), this.env, { now: () => this.now });
    return { status: res.status, bytes: new Uint8Array(await res.arrayBuffer()), headers: res.headers };
  }

  /** A request without an actor, returning the raw Response (e.g. streamed bytes from an internal route). */
  async raw(method: string, path: string, body?: unknown): Promise<Response> {
    const req = new Request(`https://media.internal${path}`, {
      method,
      headers: { "content-type": "application/json", "x-request-id": "req_test" },
      body: body === undefined ? null : JSON.stringify(body),
    });
    return route(req, this.env, { now: () => this.now });
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

// ── PV2: an in-memory R2 bucket and a Durable Object namespace over the real index core ─────────────────

import { createHash } from "node:crypto";
import { dispatchAndRecord } from "@media-worker/index-do/library-index";
import { LibraryIndexCore, type Sql } from "@media-worker/index-do/core";
import { drainOutbox } from "@media-worker/index-do/routes";
import { runPipeline, type Step, type StepConfig } from "@media-worker/pipeline/run";
import type { PipelineParams } from "@media-worker/pipeline/start";

export const sha256hex = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

async function readAll(body: unknown): Promise<Uint8Array> {
  if (body instanceof Uint8Array) return body;
  if (body instanceof ArrayBuffer) return new Uint8Array(body);
  if (typeof body === "string") return new TextEncoder().encode(body);
  return new Uint8Array(await new Response(body as ReadableStream).arrayBuffer());
}

export class FakeBucket {
  readonly objects = new Map<string, { bytes: Uint8Array; contentType: string }>();
  readonly uploads = new Map<string, { key: string; parts: Map<number, Uint8Array> }>();
  async put(key: string, body: unknown, opts?: { sha256?: string; httpMetadata?: { contentType?: string } }) {
    const bytes = await readAll(body);
    if (opts?.sha256 && sha256hex(bytes) !== opts.sha256) {
      throw new Error("put: The SHA-256 checksum you specified did not match what we received.");
    }
    this.objects.set(key, { bytes, contentType: opts?.httpMetadata?.contentType ?? "" });
    return { key, size: bytes.length };
  }
  async head(key: string) {
    const o = this.objects.get(key);
    if (!o) return null;
    const sum = createHash("sha256").update(o.bytes).digest();
    return { key, size: o.bytes.length, checksums: { sha256: sum.buffer.slice(sum.byteOffset, sum.byteOffset + sum.length) } };
  }
  async get(key: string) {
    const o = this.objects.get(key);
    if (!o) return null;
    const bytes = o.bytes;
    return {
      key,
      size: bytes.length,
      body: new Response(bytes).body!,
      arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
    };
  }
  async delete(keys: string | string[]) {
    for (const k of Array.isArray(keys) ? keys : [keys]) this.objects.delete(k);
  }
  async createMultipartUpload(key: string) {
    const uploadId = crypto.randomUUID();
    this.uploads.set(uploadId, { key, parts: new Map() });
    return { uploadId, key };
  }
  resumeMultipartUpload(key: string, uploadId: string) {
    const self = this;
    return {
      async uploadPart(n: number, body: unknown) {
        const u = self.uploads.get(uploadId);
        if (!u || u.key !== key) throw new Error("no such upload");
        u.parts.set(n, await readAll(body));
        return { partNumber: n, etag: `etag-${n}-${u.parts.get(n)!.length}` };
      },
      async complete(parts: { partNumber: number }[]) {
        const u = self.uploads.get(uploadId)!;
        const chunks = parts.map((p) => u.parts.get(p.partNumber)!);
        const out = new Uint8Array(chunks.reduce((a, c) => a + c.length, 0));
        let off = 0;
        for (const c of chunks) {
          out.set(c, off);
          off += c.length;
        }
        self.objects.set(key, { bytes: out, contentType: "" });
        self.uploads.delete(uploadId);
      },
      async abort() {
        self.uploads.delete(uploadId);
      },
    };
  }
}

/** One real LibraryIndexCore per DO name, each over its own in-memory SQLite. */
export class FakeIndexNamespace {
  readonly cores = new Map<string, LibraryIndexCore>();
  idFromName(name: string) {
    return { name, toString: () => name };
  }
  get(id: { name: string }) {
    let core = this.cores.get(id.name);
    if (!core) {
      const db = new DatabaseSync(":memory:");
      const sql: Sql = {
        // Eager, like the Durable Object's sql.exec: the statement runs now, whether or not rows are read.
        exec: (query, ...params) => {
          const rows = db.prepare(query).all(...(params as never[])) as never[];
          return { toArray: () => rows };
        },
        transaction: (fn) => {
          db.exec("BEGIN");
          try {
            const r = fn();
            db.exec("COMMIT");
            return r;
          } catch (e) {
            db.exec("ROLLBACK");
            throw e;
          }
        },
      };
      core = new LibraryIndexCore(sql);
      this.cores.set(id.name, core);
    }
    const c = core;
    return {
      call: async (scope: { orgId: string; libraryId: string; actor?: string }, req: never) => structuredClone(dispatchAndRecord(c, scope, req)),
      // The live socket: node can't make a 101, so a ticket that works answers 200 with who it was for.
      fetch: async (request: Request) => {
        if ((request.headers.get("upgrade") ?? "").toLowerCase() !== "websocket") return new Response(null, { status: 404 });
        const who = c.consumeTicket(new URL(request.url).searchParams.get("ticket") ?? "", new Date().toISOString());
        return who ? Response.json(who) : new Response(null, { status: 404 });
      },
    };
  }
}

/** A stand-in for workerd's crypto.DigestStream: a WritableStream that hashes as it goes. */
export class FakeDigestStream extends WritableStream<Uint8Array> {
  digest: Promise<ArrayBuffer>;
  constructor(_alg: string) {
    const h = createHash("sha256");
    let resolve!: (b: ArrayBuffer) => void;
    const done = new Promise<ArrayBuffer>((r) => (resolve = r));
    super({
      write(chunk) {
        h.update(chunk);
      },
      close() {
        const d = h.digest();
        resolve(d.buffer.slice(d.byteOffset, d.byteOffset + d.length));
      },
    });
    this.digest = done;
  }
}

