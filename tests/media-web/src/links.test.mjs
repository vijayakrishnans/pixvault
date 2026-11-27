import { test } from "node:test";
import assert from "node:assert/strict";
import { buildLinks, LINK_FORMATS, SIGNED_TTLS } from "../../../apps/media-web/src/utils/links.js";

const U = "https://serve.test/acme/brand/logos/mark.png";

test("an image gets URL, Markdown, HTML and BBCode embeds", () => {
  assert.deepEqual(buildLinks(U, "mark.png", "image/png"), {
    url: U,
    markdown: `![mark.png](${U})`,
    html: `<img src="${U}" alt="mark.png" loading="lazy" />`,
    bbcode: `[img]${U}[/img]`,
  });
  assert.deepEqual(LINK_FORMATS, ["url", "markdown", "html", "bbcode"]);
});

test("a non-image gets links, not embeds", () => {
  const l = buildLinks("https://serve.test/a/b/report.pdf", "report.pdf", "application/pdf");
  assert.equal(l.markdown, "[report.pdf](https://serve.test/a/b/report.pdf)");
  assert.equal(l.html, '<a href="https://serve.test/a/b/report.pdf">report.pdf</a>');
  assert.equal(l.bbcode, "[url=https://serve.test/a/b/report.pdf]report.pdf[/url]");
});

test("a hostile file name can't break out of any snippet", () => {
  const name = `x" onerror="alert(1)"><script>]](javascript:1)[/img][url=evil]`;
  const l = buildLinks(U, name, "image/png");
  assert.ok(!l.html.includes('" onerror'), l.html);
  assert.ok(!l.html.includes("<script>"), l.html);
  assert.equal((l.html.match(/</g) ?? []).length, 1);
  assert.ok(l.markdown.startsWith("![") && l.markdown.endsWith(`](${U})`), l.markdown);
  assert.ok(!/[^\\]\]\(/.test(l.markdown.slice(0, -`](${U})`.length)), l.markdown);
  const pdf = buildLinks(U, name, "application/pdf");
  assert.equal(pdf.bbcode, `[url=${U}]x" onerror="alert(1)"><script>(javascript:1)/imgurl=evil[/url]`);
});

test("signed URLs keep their query in every format", () => {
  const s = `${U}?exp=1800000000&sig=1.abc_DEF-123`;
  const l = buildLinks(s, "mark.png", "image/png");
  assert.ok(l.markdown.includes(s));
  assert.ok(l.html.includes(s.replace(/&/g, "&amp;")), l.html); // HTML attributes escape "&"
  assert.ok(l.bbcode.includes(s));
});

test("signed-link lifetimes stay inside what the API accepts", () => {
  for (const t of SIGNED_TTLS) assert.ok(t.seconds >= 60 && t.seconds <= 604800);
});
