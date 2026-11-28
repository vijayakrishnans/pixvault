import { renderEmailTemplate } from "@notifications-worker/templates/index";

describe("media.comment_mention email (Pixvault PV6)", () => {
  it("says who mentioned you where, quotes the excerpt, links to the library, and escapes everything", () => {
    const r = renderEmailTemplate(
      "media.comment_mention",
      { actorName: "Ana <b>", fileName: "logo.png", libraryName: "Brand", excerpt: "Can you check </blockquote><script>x</script>?", link: "https://app.example/o/org_1/l/lib_2" },
      { brandName: "Pixvault" },
    )!;
    expect(r.subject).toBe("Ana <b> mentioned you on logo.png");
    expect(r.html).toContain("Ana &lt;b&gt; mentioned you in a comment on logo.png in Brand.");
    expect(r.html).not.toContain("<script>");
    expect(r.html).toContain("&lt;/blockquote&gt;&lt;script&gt;");
    expect(r.html).toContain('href="https://app.example/o/org_1/l/lib_2"');
    expect(r.text).toContain("Open it: https://app.example/o/org_1/l/lib_2");
  });

  it("drops a link that isn't plain https", () => {
    const r = renderEmailTemplate("media.comment_mention", { actorName: "Ana", fileName: "a", libraryName: "b", excerpt: "", link: 'javascript:alert(1)' })!;
    expect(r.html).not.toContain("href=");
    expect(r.text).not.toContain("javascript");
  });
});
