// PV1 acceptance: no upstream brand marks ship in the media app. "ImgBed", "Sanyue", "MarSeventh" and upstream
// links may appear only in a derivation header (`Derived from MarSeventh/<repo>@<ref>:<path> (MIT), modified.`),
// in the "Replaces Sanyue-ImgHub's …" provenance comment, and nowhere user-visible.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, extname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const APP = join(ROOT, "apps/media-web");
const SKIP_DIRS = new Set(["node_modules", "dist", ".wrangler"]);
const MARKS = /imgbed|img-bed|sanyue|marseventh|telegraph-image|cf-pages|bing\.com|bingwallpaper|loliapi|anime/i;
// Provenance comments (the only place an upstream name may appear). They are comments, never rendered.
const PROVENANCE = /^\s*(\/\/|<!--|\/\*|\*)?\s*(Derived from MarSeventh\/(CloudFlare-ImgBed|Sanyue-ImgHub)@[0-9a-f]{7}:\S+ \(MIT\), modified\.|Replaces Sanyue-ImgHub's\b|src\/components\/BaseLogin\.vue\) with Cirrus email-code sign-in\.)/;
const UPSTREAM_ASSETS = /(^|\/)(logo(-dark)?\.png|BlockImg\.png|WhiteListOn\.png|404\.png|Pacifico-Regular\.woff2|UnidreamLED\.ttf|animated-banner-(dark|light)\.apng)$/;

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

// What ships to users: the app source, its static files, the HTML shell and the serving Worker. Developer docs
// (apps/media-web/docs) may describe provenance in plain sentences, as the brief allows.
const SHIPPED = ["src", "public", "worker", "index.html"];
const files = SHIPPED.flatMap((p) => {
  const full = join(APP, p);
  return statSync(full).isDirectory() ? walk(full) : [full];
});

test("the app has sources to scan", () => {
  assert.ok(files.some((f) => f.endsWith("main.js")));
  assert.ok(files.length > 10);
});

test("no upstream brand marks outside provenance comments", () => {
  const hits = [];
  for (const file of files) {
    if (![".js", ".mjs", ".vue", ".css", ".html", ".json", ".jsonc", ".svg", ".md", ".txt"].includes(extname(file))) continue;
    const lines = readFileSync(file, "utf8").split("\n");
    lines.forEach((line, i) => {
      if (MARKS.test(line) && !PROVENANCE.test(line)) hits.push(`${relative(ROOT, file)}:${i + 1}: ${line.trim().slice(0, 120)}`);
    });
  }
  assert.deepEqual(hits, [], `upstream marks found:\n${hits.join("\n")}`);
});

test("no upstream images, logos or fonts are shipped", () => {
  const assets = files.map((f) => relative(APP, f)).filter((f) => UPSTREAM_ASSETS.test(f));
  assert.deepEqual(assets, []);
});

test("the page title and mark are Pixvault's", () => {
  const html = readFileSync(join(APP, "index.html"), "utf8");
  assert.match(html, /<title>Pixvault<\/title>/);
  const en = JSON.parse(readFileSync(join(APP, "src/locales/en.json"), "utf8"));
  assert.equal(en.app.name, "Pixvault");
});

test("the scanner catches a planted mark (self-check)", () => {
  assert.ok(MARKS.test('<h1>Sanyue ImgHub</h1>'));
  assert.ok(!PROVENANCE.test('<h1>Sanyue ImgHub</h1>'));
  assert.ok(PROVENANCE.test("// Derived from MarSeventh/Sanyue-ImgHub@1621525:src/main.js (MIT), modified."));
});
