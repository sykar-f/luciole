import React from "react";
import {
  registerClientReference,
  renderToPipeableStream,
} from "react-server-dom-webpack/server.node";
const Editor = registerClientReference(
  function () {
    return null;
  },
  "local-editor",
  "Editor",
);
const manifest = { "local-editor#Editor": { id: "local-editor", chunks: [], name: "Editor" } };
const revision = process.argv[2] ?? "1";
function App() {
  return React.createElement(
    "box",
    { flexDirection: "column" },
    React.createElement("text", {}, `Server revision ${revision}`),
    React.createElement(Editor, { key: "stable-editor" }),
  );
}
renderToPipeableStream(React.createElement(App), manifest).pipe(process.stdout);
