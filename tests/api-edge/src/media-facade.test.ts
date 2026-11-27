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
    [`/v1/organizations/${ORG}/libraries/${LIB}/files/fil_1/versions`],
    [`/v1/organizations/${ORG}/libraries/${LIB}/files/fil_1/versions/3/restore`],
    [`/v1/organizations/${ORG}/media-usage`],
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
