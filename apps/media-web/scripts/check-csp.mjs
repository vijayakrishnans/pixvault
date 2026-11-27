// The media app ships under `script-src 'self'` (worker/index.js), which forbids eval. A dependency that evaluates
// strings at runtime renders a blank page in production only, because the dev server sends no CSP. That happened
// once (vue-i18n's message compiler, PV-8). This fails the build instead.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const dir = new URL("../dist/assets/", import.meta.url).pathname;
const EVAL = /\bnew Function\s*\(|(?<![.\w$])eval\s*\(/;
const hits = [];
for (const name of readdirSync(dir)) {
  if (!name.endsWith(".js")) continue;
  const text = readFileSync(join(dir, name), "utf8");
  const m = EVAL.exec(text);
  if (m) hits.push(`${name}: …${text.slice(Math.max(0, m.index - 60), m.index + 40).replace(/\s+/g, " ")}…`);
}
if (hits.length) {
  console.error(`CSP check failed: the build evaluates strings, which script-src 'self' blocks in production:\n  ${hits.join("\n  ")}`);
  process.exit(1);
}
console.log(`CSP check: ${readdirSync(dir).filter((n) => n.endsWith(".js")).length} scripts, no eval`);
