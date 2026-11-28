import { applySecurityHeaders } from "@api-edge/security-headers";

describe("API security headers (OWASP A02)", () => {
  it("adds nosniff, no framing, no referrer, HSTS, a deny-all CSP and no-store", async () => {
    const res = applySecurityHeaders(Response.json({ data: 1 }, { status: 201, headers: { "x-request-id": "r1" } }));
    expect(res.status).toBe(201);
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("x-frame-options")).toBe("DENY");
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
    expect(res.headers.get("strict-transport-security")).toContain("max-age=");
    expect(res.headers.get("content-security-policy")).toContain("default-src 'none'");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("x-request-id")).toBe("r1");
    expect(await res.json()).toEqual({ data: 1 });
  });

  it("keeps a handler's own cache-control", () => {
    const res = applySecurityHeaders(new Response("x", { headers: { "cache-control": "private, no-store, max-age=0" } }));
    expect(res.headers.get("cache-control")).toBe("private, no-store, max-age=0");
  });
});
