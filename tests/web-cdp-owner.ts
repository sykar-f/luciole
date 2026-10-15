/** Runs in a separate process so the test can terminate its ownership scope. */
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
await using browser = await Browser.start({ commandTimeoutMs: 200 });
if (process.env.OWNER_RECORD) writeFileSync(process.env.OWNER_RECORD, String(server.pid));
if (process.argv[2] === "error") await browser.evaluate("new Promise(() => {})");
else await new Promise(() => {});
