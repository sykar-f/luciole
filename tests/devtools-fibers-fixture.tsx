/** @jsxImportSource @opentui/react */
// Run by tests/devtools-fibers.test.ts as `bun --preload src/devtools/hook.ts <this file>`:
// the hook must exist before @opentui/react registers its reconciler, which a test file
// sharing its process with others cannot guarantee. Prints one JSON line.
import { act, createContext, memo, useContext, useEffect, useState, type ReactNode } from "react";
import { testRender } from "@opentui/react/test-utils";
import { createComponentTracker, fiberChannel } from "../packages/luciole/src/devtools/fibers";

const Theme = createContext("dark");
const handle: { bump?: () => void; theme?: (t: string) => void } = {};
function Leaf({ label }: { label: string }) {
  return <text>{label}</text>;
}
const MemoLeaf = memo(function MemoLeaf({ label }: { label: string }) {
  return <text>{label}</text>;
});
function Themed() {
  return <text>{useContext(Theme)}</text>;
}
function Counter() {
  const [count, setCount] = useState(0);
  useEffect(() => {
    handle.bump = () => setCount((c) => c + 1);
  }, []);
  return (
    <box id="counter" flexDirection="column">
      <text>count {count}</text>
      <Leaf label="static" />
      <MemoLeaf label="memo" />
    </box>
  );
}
function App({ children }: { children: ReactNode }) {
  const [theme, setTheme] = useState("dark");
  useEffect(() => {
    handle.theme = setTheme;
  }, []);
  return (
    <Theme.Provider value={theme}>
      <Counter />
      <Themed />
      {children}
    </Theme.Provider>
  );
}
// What Flight's client builds for a Server Component's output in development.
const fromServer = {
  $$typeof: Symbol.for("react.transitional.element"),
  type: "text",
  key: null,
  ref: null,
  props: { children: "from the Server" },
  _owner: null,
  _store: { validated: 1 },
  _debugInfo: [{ name: "NotePage", env: "Server", key: null }],
};

const channel = fiberChannel();
if (!channel) throw new Error("fiber hook not preloaded");
const tracker = createComponentTracker(() => performance.timeOrigin + performance.now());
const commits: { name: string; unnecessary: boolean }[][] = [];
let last: unknown;
const names = new Map<number, string>();
channel.subscribe((root) => {
  last = root;
  for (const node of tracker.describe(root)) names.set(node.id, node.name);
  commits.push(
    tracker
      .onCommit(root)
      .map((r) => ({ name: names.get(r.id) ?? String(r.id), unnecessary: r.unnecessary })),
  );
});
const ui = await testRender(<App>{fromServer}</App>, { width: 30, height: 8 });
await act(async () => ui.renderOnce());
await act(async () => handle.bump?.());
await act(async () => handle.theme?.("light"));
await act(async () => ui.renderOnce());
const tree = tracker.describe(last);
console.log(
  JSON.stringify({
    owner: channel.owner,
    // React DevTools keep their renderer: chaining never takes it away.
    renderers: (() => {
      const renderers = globalThis.__REACT_DEVTOOLS_GLOBAL_HOOK__?.renderers;
      return renderers instanceof Map ? renderers.size : -1;
    })(),
    commits: commits.filter((c) => c.length),
    tree: tree.map(({ name, kind, depth, renders, reason, unnecessary, hooks, rect, env }) => ({
      name,
      kind,
      depth,
      renders,
      reason,
      unnecessary,
      hooks,
      rect,
      env,
    })),
  }),
);
await act(async () => ui.renderer.destroy());
process.exit(0);
