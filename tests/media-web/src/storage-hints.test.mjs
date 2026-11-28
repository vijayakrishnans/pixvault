import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// hintFor lives in StorageSettings.vue's script block; pull it out so it can run without a Vue toolchain.
const sfc = readFileSync(new URL("../../../apps/media-web/src/components/StorageSettings.vue", import.meta.url), "utf8");
const src = sfc.match(/export function hintFor\(code\) \{[\s\S]*?\n\}/)[0].replace("export ", "");
const hintFor = new Function(`${src}; return hintFor;`)();

test("a failed bucket check points at the likely cause", () => {
  assert.equal(hintFor("InvalidAccessKeyId"), "keys");
  assert.equal(hintFor("SignatureDoesNotMatch"), "keys");
  assert.equal(hintFor("AccessDenied"), "keys");
  assert.equal(hintFor("NoSuchBucket"), "bucket");
  assert.equal(hintFor("PermanentRedirect"), "bucket");
  assert.equal(hintFor("Timeout"), "endpoint");
  assert.equal(hintFor("Unreachable"), "endpoint");
  assert.equal(hintFor("SlowDown"), "other");
});

test("every check step and hint has words in both languages", () => {
  for (const lang of ["en", "zh-CN"]) {
    const d = JSON.parse(readFileSync(new URL(`../../../apps/media-web/src/locales/${lang}.json`, import.meta.url), "utf8"));
    for (const k of ["put", "head", "get", "list", "delete", "open"]) assert.ok(d.storage.checks[k], `${lang} checks.${k}`);
    for (const k of ["keys", "bucket", "endpoint", "other"]) assert.ok(d.storage.hints[k], `${lang} hints.${k}`);
    assert.ok(d.settings.storage);
  }
});
