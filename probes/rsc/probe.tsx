/** @jsxImportSource @opentui/react */
import { testRender } from "@opentui/react/test-utils";
import { act, isValidElement, useState, useEffect } from "react";
import { spawn } from "node:child_process";
import assert from "node:assert/strict";
let field: any;
function Editor() {
  const [value, setValue] = useState("");
  return (
    <input
      focused
      value={value}
      ref={(r) => {
        if (r) field = r;
      }}
      onInput={setValue}
    />
  );
}
(globalThis as any).__webpack_require__ = (id: string) => {
  assert.equal(id, "local-editor");
  return { Editor };
};
const { createFromNodeStream } = await import("react-server-dom-webpack/client.node");
const manifest = {
  moduleMap: { "local-editor": { Editor: { id: "local-editor", chunks: [], name: "Editor" } } },
  moduleLoading: null,
  serverModuleMap: null,
};
async function load(revision: number) {
  const child = spawn(
    process.execPath,
    ["--conditions=react-server", "server.ts", String(revision)],
    { stdio: ["ignore", "pipe", "inherit"] },
  );
  const exit = new Promise<void>((resolve, reject) =>
    child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`server exit ${code}`)))),
  );
  const tree = await createFromNodeStream(child.stdout, manifest);
  await exit;
  if (!isValidElement(tree)) throw new Error("The probe Server rendered no element");
  return tree;
}
const initial = await load(1);
let refresh!: (tree: any) => void;
function Shell() {
  const [tree, setTree] = useState(initial);
  useEffect(() => {
    refresh = setTree;
  }, [setTree]);
  return tree;
}
const ui = await testRender(<Shell />, { width: 40, height: 5 });
const results: Record<string, unknown> = {
  versions: { opentui: "0.5.12", react: "19.3.0", flight: "19.3.0" },
  handwrittenManifest: true,
  serverFunctionsTested: false,
};
try {
  await act(async () => {
    await ui.mockInput.typeText("draft");
  });
  await ui.renderOnce();
  assert.equal(field.value, "draft");
  assert.ok(ui.captureCharFrame().includes("Server revision 1"));
  const instance = field;
  const next = await load(2);
  await act(async () => {
    refresh(next);
  });
  await ui.renderOnce();
  assert.ok(ui.captureCharFrame().includes("Server revision 2"));
  assert.equal(field, instance);
  assert.equal(field.value, "draft");
  await act(async () => {
    await ui.mockInput.typeText("!");
  });
  assert.equal(field.value, "draft!");
  Object.assign(results, {
    flightTreeMounted: true,
    clientReferenceResolved: true,
    serverRefreshVisible: true,
    localInstancePreserved: true,
    localDraftPreserved: true,
    typingAfterRefresh: true,
    frame: ui.captureCharFrame(),
  });
} finally {
  await act(async () => {
    ui.renderer.destroy();
  });
}
await Bun.write("results.json", JSON.stringify(results, null, 2) + "\n");
console.log(JSON.stringify(results, null, 2));
