import React from "react";
import {
  registerClientReference,
  registerServerReference,
  renderToReadableStream,
  decodeReply,
} from "../src/flight/server";
let saved = "";
const Editor = registerClientReference((_props: { save: typeof save }) => null, "editor", "Editor");
const save = registerServerReference(
  async (value: string) => {
    await Bun.sleep(400);
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
      const args = await decodeReply(await req.text(), {});
      return new Response(renderToReadableStream(await save(args[0]), {}));
    }
    return new Response(
      await renderToReadableStream(
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
