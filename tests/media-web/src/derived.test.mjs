// Every file the port inventory marks as ported into the media app (decision port/adapt, status verified) exists
// at its target and starts with its derivation header. JSON can't hold a comment; THIRD_PARTY_NOTICES covers it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const inv = JSON.parse(readFileSync(join(ROOT, "specs/epics/pixvault-team-media/port/imghub.json"), "utf8"));
const ported = inv.rows.filter(
  (r) => ["port", "adapt"].includes(r.decision) && r.status === "verified" && r.target?.startsWith("apps/media-web/"),
);

test("the inventory records ported media-web files", () => {
  assert.ok(ported.length >= 10, `only ${ported.length} rows`);
});

for (const row of ported) {
  test(`${row.id} ${row.source} → ${row.target}`, () => {
    const file = join(ROOT, row.target);
    assert.ok(existsSync(file), `${row.target} is missing`);
    if (row.target.endsWith(".json")) return;
    const head = readFileSync(file, "utf8").split("\n").slice(0, 3).join("\n");
    const expected = `Derived from MarSeventh/Sanyue-ImgHub@${inv.ref.slice(0, 7)}:${row.source} (MIT), modified.`;
    assert.ok(head.includes(expected), `${row.target} lacks "${expected}"`);
  });
}
