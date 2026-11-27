import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { createSha256, computeSha256 } from "../../../apps/media-web/src/utils/upload/sha256.js";

const node = (b) => createHash("sha256").update(b).digest("hex");

test("the incremental hasher matches Node across block and chunk boundaries", () => {
  for (const size of [0, 1, 55, 56, 63, 64, 65, 119, 120, 1000, 4096 + 17]) {
    const data = randomBytes(size);
    for (const split of [1, 7, 64, 333]) {
      const h = createSha256();
      for (let o = 0; o < data.length; o += split) h.update(data.subarray(o, o + split));
      assert.equal(h.digest(), node(data), `size ${size} split ${split}`);
    }
  }
});

test("computeSha256 matches Node on both paths (native below 32 MiB, incremental above)", async () => {
  const small = randomBytes(100_000);
  assert.equal(await computeSha256(new Blob([small])), node(small));
  const big = randomBytes(33 * 1024 * 1024 + 5);
  let last = 0;
  assert.equal(await computeSha256(new Blob([big]), (p) => (last = p)), node(big));
  assert.equal(last, 1);
});
