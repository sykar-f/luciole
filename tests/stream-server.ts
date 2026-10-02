import { renderPage } from "../packages/core/src/cache/render";
import { renderToReadableStream } from "../packages/core/src/flight/server";
// A root model (children: a title, then lines) whose async iterable outlives the Client's
// request deadline: it holds its first line until the test writes to stdin, which the test
// does after the root model has arrived and the deadline has been made to pass. Nothing waits
// on a duration the host may stretch.
async function* lines() {
  await Bun.stdin.stream().getReader().read();
  for (let i = 1; i <= 4; i++) yield `line ${i}`;
}
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  // Shaped like a real `/render` (src/server.ts): `{ tree, tags }`.
  fetch: () =>
    new Response(renderPage(["job", lines()], (model) => renderToReadableStream(model, {}))),
});
console.log(JSON.stringify({ port: server.port }));
