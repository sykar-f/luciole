import { expect, test } from "bun:test";
import { Sha256Hasher, sha256 } from "../packages/core/src/web/node/sha256";

const bun = (data: Uint8Array | string) =>
  new Bun.CryptoHasher("sha256").update(data).digest("hex");

test("the page's SHA-256 agrees with Bun's around every padding boundary", () => {
  // 55, 56 and 64 bytes are where the length spills into a second block.
  for (const length of [0, 1, 55, 56, 57, 63, 64, 65, 119, 120, 128, 1000]) {
    const data = Uint8Array.from({ length }, (_, i) => (i * 31 + length) & 0xff);
    expect(Buffer.from(sha256(data)).toString("hex")).toBe(bun(data));
  }
});

test("the hasher takes strings and views, in parts, as Bun's does", () => {
  const token = "réseau lent, clavier rapide";
  expect(new Sha256Hasher("sha256").update(token).digest("hex")).toBe(bun(token));
  const whole = new TextEncoder().encode(token);
  const parts = new Sha256Hasher("SHA256").update(whole.subarray(0, 7)).update(whole.subarray(7));
  expect(parts.digest("base64")).toBe(
    new Bun.CryptoHasher("sha256").update(whole).digest("base64"),
  );
  expect(() => new Sha256Hasher("md5")).toThrow("only sha256");
});
