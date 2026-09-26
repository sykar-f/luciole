import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";

const LENGTHS = [0, 1, 2, 3, 31, 32, 33];
const bytesOf = (length: number) => Array.from({ length }, (_, i) => (i * 67 + 251) & 0xff);

const Results = z.object({
  known: z.boolean(),
  cases: z.array(
    z.object({
      bytes: z.array(z.number()),
      encoded: z.string(),
      decoded: z.array(z.number()),
      length: z.number(),
    }),
  ),
  hex: z.string(),
});

// The browser build's Buffer is Bun's polyfill, not the runtime's: bundle for the browser,
// let the bundle compute, and compare with Bun's Buffer.
test("the browser's Buffer encodes and decodes base64url as Bun's does", async () => {
  const directory = mkdtempSync(join(tmpdir(), "airtty-buffer-"));
  try {
    const entry = join(directory, "entry.ts");
    await Bun.write(
      entry,
      `import { Buffer } from "node:buffer";
import ${JSON.stringify(join(import.meta.dir, "../packages/airtty/src/web/node/buffer-base64url.ts"))};
const cases = ${JSON.stringify(LENGTHS.map(bytesOf))}.map((bytes) => {
  const encoded = Buffer.from(bytes).toString("base64url");
  return {
    bytes,
    encoded,
    decoded: [...Buffer.from(encoded, "base64url")],
    length: Buffer.byteLength(encoded, "base64url"),
  };
});
export const results = {
  known: Buffer.isEncoding("base64url"),
  cases,
  hex: Buffer.from([0, 255]).toString("hex"),
};`,
    );
    const built = await Bun.build({ entrypoints: [entry], outdir: directory, target: "browser" });
    expect(built.success).toBe(true);
    const page = Results.parse(
      z.object({ results: z.unknown() }).parse(await import(join(directory, "entry.js"))).results,
    );
    expect(page.known).toBe(true);
    for (const { bytes, encoded, decoded, length } of page.cases) {
      expect(encoded).toBe(Buffer.from(bytes).toString("base64url"));
      expect(decoded).toEqual(bytes);
      expect(length).toBe(bytes.length);
    }
    // Other encodings are the polyfill's own.
    expect(page.hex).toBe("00ff");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
