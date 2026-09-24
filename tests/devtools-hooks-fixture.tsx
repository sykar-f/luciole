/** @jsxImportSource @opentui/react */
// Run by tests/devtools-fibers.test.ts with the hook preloaded (see devtools-fibers-fixture):
// how many fiber hook nodes each React hook adds (PRIMITIVE_NODES in src/devtools/fibers.ts),
// and hook names from an annotation as the build writes it. Prints one JSON line.
import {
  act,
  useActionState,
  useCallback,
  useDeferredValue,
  useEffect,
  useEffectEvent,
  useId,
  useImperativeHandle,
  useInsertionEffect,
  useLayoutEffect,
  useMemo,
  useOptimistic,
  useReducer,
  useRef,
  useState,
  useSyncExternalStore,
  useTransition,
} from "react";
import { testRender } from "@opentui/react/test-utils";
import { annotate } from "../src/devtools/annotate";
import { createComponentTracker, fiberChannel } from "../src/devtools/fibers";

const probes: Record<string, () => unknown> = {
  useState: () => useState(0),
  useReducer: () => useReducer((s: number) => s, 0),
  useRef: () => useRef(0),
  useMemo: () => useMemo(() => 1, []),
  useCallback: () => useCallback(() => {}, []),
  useEffect: () => useEffect(() => {}, []),
  useLayoutEffect: () => useLayoutEffect(() => {}, []),
  useInsertionEffect: () => useInsertionEffect(() => {}, []),
  useImperativeHandle: () => useImperativeHandle(useRef(null), () => null, []),
  useId: () => useId(),
  useDeferredValue: () => useDeferredValue(1),
  useSyncExternalStore: () =>
    useSyncExternalStore(
      () => () => {},
      () => 1,
    ),
  useTransition: () => useTransition(),
  useOptimistic: () => useOptimistic(1),
  useActionState: () => useActionState((s: number) => s, 0),
  useEffectEvent: () => useEffectEvent(() => {}),
};
// useImperativeHandle's probe also calls useRef: counted apart below.
const EXTRA_NODES: Record<string, number> = { useImperativeHandle: 1 };
const components = Object.entries(probes).map(([hook, use]) =>
  Object.assign(
    function Probe() {
      use();
      return null;
    },
    { displayName: `Probe_${hook}` },
  ),
);

// What a build annotates (src/build-names.ts): a local custom hook, a package's hook
// (unannotated, two nodes), and hooks before and after it.
function useLocal() {
  const [open] = useState(false);
  const input = useRef(null);
  return { open, input };
}
annotate(useLocal, null, "fixture.tsx:60", [
  ["useState", "useState", "open"],
  ["useRef", "useRef", "input"],
]);
function usePackage() {
  useState(1);
  useState(2);
}
function Annotated() {
  const [draft] = useState("abc");
  useLocal();
  usePackage();
  const total = useMemo(() => 42, []);
  useEffect(() => {}, []);
  return <text>{draft + total}</text>;
}
annotate(Annotated, "Annotated", "fixture.tsx:75", [
  ["useState", "useState", "draft"],
  [useLocal, "useLocal", "local"],
  [usePackage, "usePackage", null],
  ["useMemo", "useMemo", "total"],
  ["useEffect", "useEffect", null],
]);

const channel = fiberChannel();
if (!channel) throw new Error("fiber hook not preloaded");
const tracker = createComponentTracker(() => Date.now());
let last: unknown;
channel.subscribe((root) => {
  last = root;
  tracker.onCommit(root);
});
const ui = await testRender(
  <box>
    {components.map((Probe) => (
      <Probe key={Probe.displayName} />
    ))}
    <Annotated />
  </box>,
  { width: 30, height: 4 },
);
await act(async () => ui.renderOnce());
const tree = tracker.describe(last);
const counts = Object.fromEntries(
  Object.keys(probes).map((hook) => [
    hook,
    (tree.find((n) => n.name === `Probe_${hook}`)?.hooks?.length ?? -1) - (EXTRA_NODES[hook] ?? 0),
  ]),
);
const annotated = tree.find((n) => n.name === "Annotated");
console.log(JSON.stringify({ counts, hooks: annotated?.hooks, source: annotated?.source }));
await act(async () => ui.renderer.destroy());
process.exit(0);
