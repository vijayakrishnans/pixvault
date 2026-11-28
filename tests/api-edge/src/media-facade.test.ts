import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { handleMediaRoute, isMediaRoute } from "@api-edge/media-facade";
import { isProjectRoute } from "@api-edge/project-facade";
import { isOrgRoute } from "@api-edge/org-facade";

const __dirname = dirname(fileURLToPath(import.meta.url));

interface Call {
  url: string;
  init: RequestInit;
}

function fetcher(respond: (url: string) => Response): { fetcher: Fetcher; calls: Call[] } {
  const calls: Call[] = [];
  return {
    calls,
    fetcher: {
      fetch(input: string | Request | URL, init?: RequestInit) {
        const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
        calls.push({ url, init: init ?? {} });
        return Promise.resolve(respond(url));
      },
      connect() {
        throw new Error("not implemented");
      },
    } as unknown as Fetcher,
  };
}

const identity = () =>
  fetcher(() =>
    Response.json({
      data: { actor: { actorType: "user", actorId: "usr_" + "a".repeat(32), email: "u@example.test" }, user: { id: "usr_x", email: "u@example.test" } },
      meta: { requestId: "r", cursor: null },
    }),
  );

const ORG = "org_" + "1".repeat(32);
const LIB = "lib_" + "2".repeat(32);

describe("api-edge media facade", () => {
  it.each([
    [`/v1/organizations/${ORG}/libraries`],
    [`/v1/organizations/${ORG}/libraries/${LIB}`],
    [`/v1/organizations/${ORG}/libraries/${LIB}/members`],
    [`/v1/organizations/${ORG}/libraries/${LIB}/members/usr_x`],
    [`/v1/organizations/${ORG}/libraries/${LIB}/invitations`],
    [`/v1/organizations/${ORG}/libraries/${LIB}/invitations/lbi_x`],
    ["/v1/media/libraries"],
    ["/v1/media/invitations/accept"],
    [`/v1/organizations/${ORG}/libraries/${LIB}/uploads`],
    [`/v1/organizations/${ORG}/libraries/${LIB}/uploads/ups_1`],
    [`/v1/organizations/${ORG}/libraries/${LIB}/uploads/ups_1/parts/12`],
    [`/v1/organizations/${ORG}/libraries/${LIB}/uploads/ups_1/commit`],
    [`/v1/organizations/${ORG}/libraries/${LIB}/files`],
    [`/v1/organizations/${ORG}/libraries/${LIB}/files/fil_1`],
    [`/v1/organizations/${ORG}/libraries/${LIB}/files/fil_1/content`],
    [`/v1/organizations/${ORG}/libraries/${LIB}/files/fil_1/restore`],
    [`/v1/organizations/${ORG}/libraries/${LIB}/files/fil_1/signed-url`],
    [`/v1/organizations/${ORG}/libraries/${LIB}/files/fil_1/reprocess`],
    [`/v1/organizations/${ORG}/libraries/${LIB}/files/fil_1/review`],
    [`/v1/organizations/${ORG}/libraries/${LIB}/files/fil_1/versions`],
    [`/v1/organizations/${ORG}/libraries/${LIB}/files/fil_1/versions/3/restore`],
    [`/v1/organizations/${ORG}/media-usage`],
    [`/v1/organizations/${ORG}/libraries/${LIB}/files:batch`],
    [`/v1/organizations/${ORG}/libraries/${LIB}/folders`],
    [`/v1/organizations/${ORG}/libraries/${LIB}/folders/move`],
    [`/v1/organizations/${ORG}/libraries/${LIB}/folders/trash`],
    [`/v1/organizations/${ORG}/libraries/${LIB}/tags`],
    [`/v1/organizations/${ORG}/libraries/${LIB}/live-tickets`],
    [`/v1/organizations/${ORG}/libraries/${LIB}/live`],
  ])("routes %s to media-worker, not the project or org facades", (path) => {
    expect(isMediaRoute(path)).toBe(true);
    expect(isProjectRoute(path)).toBe(false);
  });

  it("leaves Cirrus routes alone", () => {
    expect(isMediaRoute(`/v1/organizations/${ORG}/projects`)).toBe(false);
    expect(isMediaRoute(`/v1/organizations/${ORG}/members`)).toBe(false);
    expect(isOrgRoute(`/v1/organizations/${ORG}/members`)).toBe(true);
    expect(isMediaRoute(`/v1/organizations/${ORG}/libraries/${LIB}/uploads/ups_1/parts/x`)).toBe(false);
    expect(isMediaRoute(`/v1/organizations/${ORG}/usage`)).toBe(false); // metering's
  });

  it("refuses methods a route doesn't take (405) without calling anything", async () => {
    const id = identity();
    const media = fetcher(() => Response.json({}));
    const res = await handleMediaRoute(
      new Request(`https://edge/v1/organizations/${ORG}/libraries`, { method: "DELETE" }),
      { IDENTITY_WORKER: id.fetcher, MEDIA_WORKER: media.fetcher, ENVIRONMENT: "test" },
      "req_1",
      `/v1/organizations/${ORG}/libraries`,
    );
    expect(res.status).toBe(405);
    expect(media.calls).toHaveLength(0);
  });

  it("forwards the live socket's upgrade with its ticket, without a bearer, and only the WebSocket headers", async () => {
    const id = identity();
    const media = fetcher(() => new Response(null, { status: 404 }));
    const path = `/v1/organizations/${ORG}/libraries/${LIB}/live`;
    const res = await handleMediaRoute(
      new Request(`https://edge${path}?ticket=${"a".repeat(64)}`, {
        headers: { upgrade: "websocket", connection: "Upgrade", "sec-websocket-key": "k==", "sec-websocket-version": "13", authorization: "Bearer x", cookie: "s=1" },
      }),
      { IDENTITY_WORKER: id.fetcher, MEDIA_WORKER: media.fetcher, ENVIRONMENT: "test" },
      "req_live",
      path,
    );
    expect(res.status).toBe(404); // media-worker's answer, untouched
    expect(id.calls).toHaveLength(0);
    expect(media.calls).toHaveLength(1);
    expect(media.calls[0]!.url).toBe(`https://media.internal${path}?ticket=${"a".repeat(64)}`);
    const h = new Headers(media.calls[0]!.init.headers);
    expect(h.get("upgrade")).toBe("websocket");
    expect(h.get("sec-websocket-key")).toBe("k==");
    expect(h.get("authorization")).toBeNull();
    expect(h.get("cookie")).toBeNull();
    expect(h.get("x-actor-subject-id")).toBeNull();
    // not an upgrade: 426, nothing forwarded
    const plain = await handleMediaRoute(new Request(`https://edge${path}`), { IDENTITY_WORKER: id.fetcher, MEDIA_WORKER: media.fetcher, ENVIRONMENT: "test" }, "req_l2", path);
    expect(plain.status).toBe(426);
    expect(media.calls).toHaveLength(1);
  });

  it("requires a bearer token (401) and never forwards anonymous calls", async () => {
    const media = fetcher(() => Response.json({}));
    const res = await handleMediaRoute(
      new Request(`https://edge/v1/organizations/${ORG}/libraries`),
      { IDENTITY_WORKER: identity().fetcher, MEDIA_WORKER: media.fetcher, ENVIRONMENT: "test" },
      "req_2",
      `/v1/organizations/${ORG}/libraries`,
    );
    expect(res.status).toBe(401);
    expect(media.calls).toHaveLength(0);
  });

  it("forwards the resolved actor, never the caller's own x-actor headers, and passes the body through", async () => {
    const media = fetcher(() => Response.json({ data: { ok: true }, meta: { requestId: "req_3", cursor: null } }, { status: 201 }));
    const path = `/v1/organizations/${ORG}/libraries`;
    const res = await handleMediaRoute(
      new Request(`https://edge${path}`, {
        method: "POST",
        headers: {
          authorization: "Bearer sps_ses_test",
          "content-type": "application/json",
          "x-actor-subject-id": "usr_forged",
          "x-actor-subject-type": "system",
        },
        body: JSON.stringify({ name: "Brand assets" }),
      }),
      { IDENTITY_WORKER: identity().fetcher, MEDIA_WORKER: media.fetcher, ENVIRONMENT: "test" },
      "req_3",
      path,
    );
    expect(res.status).toBe(201);
    expect(media.calls).toHaveLength(1);
    const call = media.calls[0]!;
    expect(call.url).toBe(`https://media.internal${path}`);
    const h = new Headers(call.init.headers);
    expect(h.get("x-actor-subject-id")).toBe("usr_" + "a".repeat(32));
    expect(h.get("x-actor-subject-type")).toBe("user");
    expect(h.get("authorization")).toBeNull();
    expect(await new Response(call.init.body).json()).toEqual({ name: "Brand assets" });
  });

  it("streams a part's raw bytes through to media-worker", async () => {
    const media = fetcher(() => Response.json({ data: {}, meta: { requestId: "r", cursor: null } }));
    const path = `/v1/organizations/${ORG}/libraries/${LIB}/uploads/ups_1/parts/1`;
    const bytes = new Uint8Array([1, 2, 3, 250, 251]);
    const res = await handleMediaRoute(
      new Request(`https://edge${path}`, { method: "PUT", headers: { authorization: "Bearer sps_ses_test" }, body: bytes }),
      { IDENTITY_WORKER: identity().fetcher, MEDIA_WORKER: media.fetcher, ENVIRONMENT: "test" },
      "req_5",
      path,
    );
    expect(res.status).toBe(200);
    expect(new Uint8Array(await new Response(media.calls[0]!.init.body).arrayBuffer())).toEqual(bytes);
  });

  it("answers 503 when media-worker isn't bound", async () => {
    const path = "/v1/media/libraries";
    const res = await handleMediaRoute(
      new Request(`https://edge${path}`, { headers: { authorization: "Bearer sps_ses_test" } }),
      { IDENTITY_WORKER: identity().fetcher, ENVIRONMENT: "test" },
      "req_4",
      path,
    );
    expect(res.status).toBe(503);
  });

  it("binds MEDIA_WORKER on stage and prod", () => {
    const text = readFileSync(resolve(__dirname, "../../../apps/api-edge/wrangler.template.jsonc"), "utf8");
    for (const env of ["stage", "prod"]) {
      expect(text).toContain(`"service": "pixvault-media-worker-${env}"`);
    }
  });
});

describe("media admin and abuse intake routing (PV-25)", () => {
  it("forwards the operator routes and never the abuse intake", async () => {
    const { isMediaRoute } = await import("../../../apps/api-edge/src/media-facade.js");
    for (const p of [
      "/v1/media/admin/abuse-cases",
      "/v1/media/admin/abuse-cases/abc_0123/takedown",
      "/v1/media/admin/abuse-cases/abc_0123/dismiss",
      "/v1/media/admin/organizations/org_1/libraries/lib_2/files/fil_3/takedown",
      "/v1/media/admin/organizations/org_1/libraries/lib_2/files/fil_3/reinstate",
      "/v1/media/admin/organizations/org_1/suspend",
      "/v1/media/admin/pipeline-failures",
    ]) expect(isMediaRoute(p)).toBe(true);
    expect(isMediaRoute("/v1/media/abuse-reports")).toBe(false);
    expect(isMediaRoute("/v1/media/admin/organizations/org_1/delete")).toBe(false);
  });
});
