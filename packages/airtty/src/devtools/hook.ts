/**
 * The React DevTools global hook, preloaded (`BUN_OPTIONS=--preload=…/hook.ts`, see
 * docs/DEVTOOLS.md) so it exists before `@opentui/react` evaluates: its reconciler calls
 * `injectIntoDevTools()` once, at import, and a hook installed any later never hears a
 * commit. The Client bundle imports `@opentui/react` as an external module, evaluated
 * before any bundled code; only a preload runs earlier.
 *
 * It chains, like react-scan/bippy: with `DEV=true`, OpenTUI connects React DevTools, whose
 * hook must be the real one; this module lets `react-devtools-core` install it first
 * (OpenTUI's own later `initialize()` then finds it and keeps it) and wraps its
 * `onCommitFiberRoot`. Otherwise it installs a minimal hook of its own. Either way,
 * commits reach the DevTools agent through `globalThis.__AIRTTY_FIBERS__`: the agent
 * lives in the Client bundle, another module instance than this preload.
 */
type Listener = (root: unknown) => void;
type Hook = Record<string, unknown> & {
  onCommitFiberRoot?: (...args: unknown[]) => unknown;
};
/** What the agent reads (src/devtools/fibers.ts checks its shape). */
export type FiberChannel = {
  version: 1;
  subscribe(listener: Listener): () => void;
  /** The roots committed so far, for an agent attached after the first commit. */
  roots: Set<unknown>;
  /** `react-devtools` when chained onto React DevTools' hook, `airtty` otherwise. */
  owner: "react-devtools" | "airtty";
};
declare global {
  var __REACT_DEVTOOLS_GLOBAL_HOOK__: Hook | undefined;
  var __AIRTTY_FIBERS__: FiberChannel | undefined;
}

const listeners = new Set<Listener>();
const roots = new Set<unknown>();
const notify = (root: unknown) => {
  roots.add(root);
  for (const listener of listeners)
    try {
      listener(root);
    } catch {
      // An inspector never breaks a commit.
    }
};

async function reactDevtoolsFirst() {
  if (process.env.DEV !== "true") return;
  // The globals OpenTUI's devtools polyfill sets before loading react-devtools-core.
  Object.assign(globalThis, {
    window: globalThis.window ?? globalThis,
    self: globalThis.self ?? globalThis,
  });
  try {
    // Named at runtime: react-devtools-core ships no types and is OpenTUI's optional peer.
    const specifier = "react-devtools-core";
    const loaded: unknown = await import(specifier);
    const devtools: unknown =
      typeof loaded === "object" && loaded !== null && "default" in loaded
        ? loaded.default
        : loaded;
    if (
      typeof devtools === "object" &&
      devtools !== null &&
      "initialize" in devtools &&
      typeof devtools.initialize === "function"
    )
      Reflect.apply(devtools.initialize, devtools, []);
  } catch {
    // Not installed: OpenTUI prints how to install it; our own hook serves meanwhile.
  }
}

function install(): FiberChannel["owner"] {
  const existing = globalThis.__REACT_DEVTOOLS_GLOBAL_HOOK__;
  if (existing && typeof existing.onCommitFiberRoot === "function") {
    const original = existing.onCommitFiberRoot.bind(existing);
    existing.onCommitFiberRoot = (...args: unknown[]) => {
      try {
        return original(...args);
      } finally {
        notify(args[1]);
      }
    };
    return "react-devtools";
  }
  let renderers = 0;
  globalThis.__REACT_DEVTOOLS_GLOBAL_HOOK__ = {
    // What react-reconciler checks before injecting (`injectInternals`).
    isDisabled: false,
    supportsFiber: true,
    renderers: new Map<number, unknown>(),
    inject: () => ++renderers,
    checkDCE: () => {},
    onScheduleFiberRoot: () => {},
    onCommitFiberRoot: (_renderer: unknown, root: unknown) => notify(root),
    onPostCommitFiberRoot: () => {},
    onCommitFiberUnmount: () => {},
  };
  return "airtty";
}

if (!globalThis.__AIRTTY_FIBERS__) {
  await reactDevtoolsFirst();
  globalThis.__AIRTTY_FIBERS__ = {
    version: 1,
    roots,
    owner: install(),
    subscribe(listener) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
  };
}
