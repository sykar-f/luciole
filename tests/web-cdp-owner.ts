/** Runs in a separate process so the test can terminate its ownership scope. */
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { listening } from "../scripts/pty/harness";
import { Browser } from "../scripts/web/cdp";

await using server = await listening(
  [
    process.execPath,
    "-e",
    `
const server = Bun.serve({ port: 0, fetch: () => new Response("ready") });
console.log(JSON.stringify({ port: server.port }));
`,
  ],
  {},
);
if (process.env.OWNER_RECORD) writeFileSync(process.env.OWNER_RECORD, String(server.pid));
await using browser = await Browser.start({ commandTimeoutMs: 200 });
if (process.argv[2] === "exceptions") {
  for (const evaluate of [
    (expression: string) => browser.evaluate(expression),
    (expression: string) => browser.evaluateIn("https://frame.test", expression),
  ]) {
    assert.equal(await evaluate("value"), 42);
    for (const { expression, message } of [
      { expression: "description", message: "Error: the expression failed" },
      { expression: "empty", message: "" },
      { expression: "missing-description", message: "Uncaught" },
      { expression: "missing-exception", message: "Uncaught" },
    ])
      await assert.rejects(evaluate(expression), { message });
  }
} else if (process.argv[2] === "wait") await browser.waitFor("true", "a response");
else if (process.argv[2] === "normal") await browser.send("Page.navigate", { url: "about:blank" });
else if (process.argv[2] === "error") await browser.evaluate("new Promise(() => {})");
else await new Promise(() => {});
