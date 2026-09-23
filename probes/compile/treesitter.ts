// Exercises OpenTUI's runtime assets inside a compiled binary: parser.worker.js
// (new Worker on an embedded file), tree-sitter.wasm and a grammar .wasm/.scm.
import { getTreeSitterClient } from "@opentui/core";

const client = getTreeSitterClient();
await client.initialize();
const result = await client.highlightOnce("const answer: number = 42;", "typescript");
console.log(
  JSON.stringify({ highlights: result.highlights?.length ?? 0, error: result.error ?? null }),
);
await client.destroy();
process.exit(result.highlights?.length ? 0 : 1);
