import React from "react";
import { createInterface } from "node:readline";
import { z } from "zod";
import {
  registerClientReference,
  registerServerReference,
  renderToReadableStream,
  decodeReply,
} from "../packages/core/src/flight/server";
let saved = "";
// The test releases each save with a line on stdin: the save stays in flight for as long as
// the test types, however slow the host.
const releases = createInterface({ input: process.stdin })[Symbol.asyncIterator]();
const Editor = registerClientReference((_props: { save: typeof save }) => null, "editor", "Editor");
const save = registerServerReference(
  async (value: string) => {
    await releases.next();
    saved = value;
    return { value, pid: process.pid };
  },
  "save",
  "default",
);
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(req) {
    if (req.method === "POST") {
      const [value] = z.tuple([z.string()]).parse(await decodeReply(await req.text(), {}));
      return new Response(renderToReadableStream(await save(value), {}));
    }
    return new Response(
      renderToReadableStream(
        React.createElement(
          "box",
          { flexDirection: "column" },
          React.createElement("text", {}, `Saved:${saved}`),
          React.createElement(Editor, { key: "note", save }),
        ),
        { "editor#Editor": { id: "editor", chunks: [], name: "Editor" } },
      ),
    );
  },
});
console.log(JSON.stringify({ port: server.port, pid: process.pid }));
