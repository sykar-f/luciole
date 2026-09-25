import { renderPage } from "../packages/airtty/src/cache/render";
import { renderToReadableStream } from "../packages/airtty/src/flight/server";
// A root model (children: a title, then lines) whose async iterable outlives the Client's
// request timeout.
async function* lines() {
  for (let i = 1; i <= 4; i++) {
    await Bun.sleep(100);
    yield `line ${i}`;
  }
}
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  // Shaped like a real `/render` (src/server.ts): `{ tree, tags }`.
  fetch: () =>
    new Response(renderPage(["job", lines()], (model) => renderToReadableStream(model, {}))),
});
console.log(JSON.stringify({ port: server.port }));
