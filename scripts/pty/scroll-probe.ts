/**
 * Preloaded into the Client the scroll bench drives (`BUN_OPTIONS=--preload=…`, as the
 * DevTools hook is: docs/DEVTOOLS.md): writes to SCROLL_PROBE_OUT, one JSON line each,
 * every wheel event OpenTUI dispatches, every React commit (with the components that
 * rendered in it) and every frame OpenTUI draws (its whole time and the native part:
 * diff and ANSI output). The Client bundle imports `@opentui/core` as an external
 * module: the class patched here is the one it runs.
 */
import { appendFileSync } from "node:fs";
import { CliRenderer } from "@opentui/core";

const out = process.env.SCROLL_PROBE_OUT;
const record = (entry: Record<string, unknown>) => {
  if (out) appendFileSync(out, `${JSON.stringify({ at: performance.now(), ...entry })}\n`);
};

// React's PerformedWork flag: the component's function ran in this render.
const PERFORMED_WORK = 1;
const field = (value: unknown, name: string): unknown =>
  typeof value === "object" && value !== null ? Reflect.get(value, name) : undefined;
/** The function components that ran in the commit of `root` (a FiberRoot). */
function rendered(root: unknown) {
  const names: string[] = [];
  const visit = (fiber: unknown) => {
    for (let node = fiber; node; node = field(node, "sibling")) {
      const type = field(node, "type");
      const flags = field(node, "flags");
      if (
        typeof type === "function" &&
        field(node, "alternate") &&
        typeof flags === "number" &&
        flags & PERFORMED_WORK
      )
        names.push(type.name || "anonymous");
      visit(field(node, "child"));
    }
  };
  visit(field(root, "current"));
  return names;
}

let renderers = 0;
globalThis.__REACT_DEVTOOLS_GLOBAL_HOOK__ = {
  isDisabled: false,
  supportsFiber: true,
  renderers: new Map<number, unknown>(),
  inject: () => ++renderers,
  checkDCE: () => {},
  onScheduleFiberRoot: () => {},
  onCommitFiberRoot: (_renderer: unknown, root: unknown) =>
    record({ kind: "commit", components: rendered(root) }),
  onPostCommitFiberRoot: () => {},
  onCommitFiberUnmount: () => {},
};

type Method = (this: unknown, ...args: unknown[]) => unknown;
/** Replaces a method of CliRenderer with `around` the original. */
const wrap = (name: string, around: (original: Method) => Method) => {
  const original: unknown = Reflect.get(CliRenderer.prototype, name);
  if (typeof original !== "function") return;
  const call: Method = function (...args) {
    return Reflect.apply(original, this, args);
  };
  Reflect.set(CliRenderer.prototype, name, around(call));
};
let native = 0;
wrap(
  "renderNative",
  (original) =>
    function (this: unknown, ...args) {
      const start = performance.now();
      try {
        return original.apply(this, args);
      } finally {
        native += performance.now() - start;
      }
    },
);
wrap(
  "loop",
  (original) =>
    async function (this: unknown, ...args) {
      const start = performance.now();
      native = 0;
      await original.apply(this, args);
      if (native > 0) record({ kind: "frame", ms: performance.now() - start, nativeMs: native });
    },
);
wrap(
  "processSingleMouseEvent",
  (original) =>
    function (this: unknown, ...args) {
      const [event] = args;
      if (typeof event === "object" && event && Reflect.get(event, "type") === "scroll")
        record({ kind: "wheel" });
      return original.apply(this, args);
    },
);
