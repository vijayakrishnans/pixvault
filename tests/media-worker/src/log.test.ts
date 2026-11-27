// PV-12: an unhandled error writes one structured line (route template, request id, error name and message),
// with URLs, long hex tokens and emails redacted.
import { jest } from "@jest/globals";
import { World } from "./harness.js";
import { routeTemplate } from "@media-worker/log";

describe("media-worker logs", () => {
  it("templates routes so ids never reach the logs", () => {
    expect(routeTemplate(`/v1/organizations/org_${"a".repeat(32)}/libraries/lib_${"b".repeat(32)}/uploads/ups_${"c".repeat(32)}/parts/7`)).toBe(
      "/v1/organizations/:id/libraries/:id/uploads/:id/parts/:n",
    );
  });

  it("an unhandled error logs one JSON line and answers 503", async () => {
    const w = new World();
    const A = w.newOrg();
    const owner = w.newUser("owner");
    w.grant(A, owner, "owner");
    const lib = (await w.call(owner, "POST", `/v1/organizations/${A.pub}/libraries`, { name: "Logs" })).json.data.library;
    // Break the index: every call throws an error whose message carries a URL, a token-like hex string and an email.
    (w.env as { LIBRARY_INDEX: unknown }).LIBRARY_INDEX = {
      idFromName: (n: string) => n,
      get: () => ({
        call: async () => {
          throw new TypeError(`fetch https://example.test/secret?sig=${"f".repeat(64)} failed for someone@example.test`);
        },
      }),
    };
    const spy = jest.spyOn(console, "error").mockImplementation(() => {});
    const r = await w.call(owner, "GET", `/v1/organizations/${A.pub}/libraries/${lib.id}/files`);
    expect(r.status).toBe(503);
    const lines = spy.mock.calls.map((c) => String(c[0]));
    spy.mockRestore();
    const line = JSON.parse(lines.find((l) => l.includes("media_error"))!);
    expect(line).toMatchObject({ level: "error", where: "GET /v1/organizations/:id/libraries/:id/files", requestId: "req_test", name: "TypeError" });
    expect(line.message).not.toMatch(/https?:|f{40}|@example\.test/);
    expect(JSON.stringify(line)).not.toContain(lib.id.slice(4));
  });
});
