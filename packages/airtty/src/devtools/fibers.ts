import type { FiberChannel } from "./hook";
import type { ComponentNode } from "./schema";
import { preview } from "./preview";

/**
 * The Components panel's source: React fibers, read after each commit through the
 * preloaded hook (hook.ts). Written against react-reconciler 0.33 (React 19.3), whose
 * internals are not an API: every field is read defensively and an unknown shape is
 * skipped, never trusted. Home-grown rather than bippy: bippy's value is the hook
 * install (a few lines here) and DOM helpers a terminal has no use for; what the panel
 * needs — render reasons, hooks, Flight's Server Components, OpenTUI rectangles — is
 * ours to write anyway, without a dependency in every Client bundle.
 */

type Fiber = {
  tag: number;
  type: unknown;
  elementType: unknown;
  key: string | null;
  memoizedProps: unknown;
  memoizedState: unknown;
  child: Fiber | null;
  sibling: Fiber | null;
  alternate: Fiber | null;
  stateNode: unknown;
  flags: number;
  dependencies: unknown;
  _debugInfo?: unknown;
};
const isFiber = (value: unknown): value is Fiber =>
  typeof value === "object" &&
  value !== null &&
  "tag" in value &&
  typeof value.tag === "number" &&
  "child" in value &&
  "sibling" in value &&
  "alternate" in value &&
  "flags" in value &&
  typeof value.flags === "number";
const rootFiber = (root: unknown) =>
  typeof root === "object" && root !== null && "current" in root && isFiber(root.current)
    ? root.current
    : undefined;
// Functions too: a component's `displayName` and annotation live on it.
const field = (value: unknown, key: string): unknown =>
  ((typeof value === "object" && value !== null) || typeof value === "function") && key in value
    ? Object.getOwnPropertyDescriptor(value, key)?.value
    : undefined;
const child = (fiber: Fiber) => (isFiber(fiber.child) ? fiber.child : null);
const sibling = (fiber: Fiber) => (isFiber(fiber.sibling) ? fiber.sibling : null);
const alternate = (fiber: Fiber) => (isFiber(fiber.alternate) ? fiber.alternate : null);

// Work tags of react-reconciler 0.33 (ReactWorkTags).
const TAG = {
  function: 0,
  class: 1,
  host: 5,
  hostText: 6,
  forwardRef: 11,
  suspense: 13,
  memo: 14,
  simpleMemo: 15,
} as const;
const COMPOSITE = new Set<number>([
  TAG.function,
  TAG.class,
  TAG.forwardRef,
  TAG.memo,
  TAG.simpleMemo,
]);
/** ReactFiberFlags.PerformedWork: the component function (or render) ran. */
const PERFORMED_WORK = 1;
const MAX_HOOKS = 16;
const MAX_PROPS = 16;

const nameOf = (type: unknown): string => {
  if (typeof type === "function") {
    const display = field(type, "displayName");
    return typeof display === "string" ? display : type.name || "Anonymous";
  }
  if (typeof type === "string") return type;
  const display = field(type, "displayName");
  if (typeof display === "string") return display;
  // forwardRef keeps its function in `render`, memo the wrapped type in `type`.
  const inner = field(type, "render") ?? field(type, "type");
  return inner === undefined || inner === type ? "Anonymous" : nameOf(inner);
};
// A memo's name (and annotation, src/build-names.ts) is on the wrapper, its fiber's `elementType`.
const fiberName = (fiber: Fiber) =>
  fiber.tag === TAG.suspense ? "Suspense" : nameOf(fiber.elementType ?? fiber.type);
/** What the build recorded (src/devtools/annotate.ts): source `file:line` and hook calls. */
type Annotation = {
  source?: string;
  file?: string;
  hooks: (readonly [unknown, string, string | null])[];
};
function annotationOf(value: unknown): Annotation | undefined {
  const found = field(value, "__airtty");
  const hooks = field(found, "hooks");
  if (!Array.isArray(hooks)) return undefined;
  const source = field(found, "source");
  const file = field(found, "file");
  return {
    source: typeof source === "string" ? source : undefined,
    file: typeof file === "string" ? file : undefined,
    hooks: hooks.flatMap((entry: unknown) =>
      Array.isArray(entry) && typeof entry[1] === "string"
        ? [[entry[0], entry[1], typeof entry[2] === "string" ? entry[2] : null] as const]
        : [],
    ),
  };
}
const fiberAnnotation = (fiber: Fiber) =>
  annotationOf(fiber.elementType) ??
  annotationOf(fiber.type) ??
  annotationOf(field(fiber.type, "render"));

/** A Server Component, as Flight describes it in development (`ReactComponentInfo`). */
type ServerInfo = { name: string; env?: string; key?: string };
const serverComponents = (fiber: Fiber): ServerInfo[] => {
  const info = fiber._debugInfo;
  if (!Array.isArray(info)) return [];
  return info.flatMap((entry: unknown) => {
    const name = field(entry, "name");
    if (typeof name !== "string") return [];
    const env = field(entry, "env");
    const key = field(entry, "key");
    return [
      {
        name,
        env: typeof env === "string" ? env : undefined,
        key: typeof key === "string" ? key : undefined,
      },
    ];
  });
};

type Rect = { x: number; y: number; width: number; height: number };
/** An OpenTUI renderable's box, in screen cells. */
const rectOf = (node: unknown): Rect | undefined => {
  const x = readGetter(node, "screenX");
  const y = readGetter(node, "screenY");
  const width = readGetter(node, "width");
  const height = readGetter(node, "height");
  return typeof x === "number" &&
    typeof y === "number" &&
    typeof width === "number" &&
    typeof height === "number"
    ? { x, y, width, height }
    : undefined;
};
function readGetter(node: unknown, key: string): unknown {
  if (typeof node !== "object" || node === null || !(key in node)) return undefined;
  try {
    return Reflect.get(node, key);
  } catch {
    return undefined;
  }
}
const union = (rects: readonly Rect[]): Rect | undefined => {
  const visible = rects.filter((r) => r.width > 0 && r.height > 0);
  if (!visible.length) return undefined;
  const x = Math.min(...visible.map((r) => r.x));
  const y = Math.min(...visible.map((r) => r.y));
  return {
    x,
    y,
    width: Math.max(...visible.map((r) => r.x + r.width)) - x,
    height: Math.max(...visible.map((r) => r.y + r.height)) - y,
  };
};
/** The box of a component: its outermost host elements, together. */
function hostRect(fiber: Fiber): Rect | undefined {
  if (fiber.tag === TAG.host) return rectOf(fiber.stateNode);
  const rects: Rect[] = [];
  for (let c = child(fiber); c; c = sibling(c)) {
    const rect = hostRect(c);
    if (rect) rects.push(rect);
  }
  return union(rects);
}

/**
 * Hook nodes each of React's hooks adds to a fiber (react-reconciler 0.33; checked by
 * tests/devtools-fibers.test.ts). `useContext`, `use` and `useDebugValue` add none.
 */
export const PRIMITIVE_NODES: Record<string, number> = {
  useState: 1,
  useReducer: 1,
  useRef: 1,
  useMemo: 1,
  useCallback: 1,
  useEffect: 1,
  useLayoutEffect: 1,
  useInsertionEffect: 1,
  useImperativeHandle: 1,
  useId: 1,
  useDeferredValue: 1,
  useSyncExternalStore: 2,
  useTransition: 2,
  useOptimistic: 1,
  useActionState: 3,
  useEffectEvent: 1,
  useContext: 0,
  use: 0,
  useDebugValue: 0,
};
const MAX_EXPANSION_DEPTH = 6;
/** A run of known hook nodes, or a custom hook from a package, of unknown length. */
type Segment = { labels: string[] } | { unknown: string };
/**
 * The hook nodes a function's recorded calls produce, labelled with the variables they
 * feed. An annotated custom hook expands into its own calls (`draft › value`).
 */
function expand(annotation: Annotation, prefix: string, depth: number): Segment[] {
  const segments: Segment[] = [];
  const known = (labels: string[]) => {
    const last = segments.at(-1);
    if (last && "labels" in last) last.labels.push(...labels);
    else segments.push({ labels });
  };
  for (const [ref, callee, binding] of annotation.hooks) {
    const label = `${prefix}${binding ?? callee}`;
    const count = PRIMITIVE_NODES[callee];
    if (count !== undefined) {
      known(Array.from({ length: count }, (_, i) => (i ? `${label} (${callee} ${i + 1})` : label)));
      continue;
    }
    const inner = annotationOf(ref);
    if (inner && depth < MAX_EXPANSION_DEPTH)
      for (const segment of expand(inner, `${label} › `, depth + 1))
        if ("labels" in segment) known(segment.labels);
        else segments.push(segment);
    else segments.push({ unknown: label });
  }
  return segments;
}
/**
 * One label per node, or `undefined` where it cannot be known: the nodes before the first
 * package hook and after the last are counted exactly; those of a single package hook in
 * between are its own. With two package hooks, the nodes between them stay unnamed.
 */
function hookLabels(annotation: Annotation | undefined, nodes: number): (string | undefined)[] {
  const labels: (string | undefined)[] = Array.from({ length: nodes }, () => undefined);
  if (!annotation) return labels;
  const segments = expand(annotation, "", 0);
  const firstUnknown = segments.findIndex((s) => "unknown" in s);
  const flat = (list: Segment[]) => list.flatMap((s) => ("labels" in s ? s.labels : []));
  if (firstUnknown < 0) {
    const all = flat(segments);
    // A count that disagrees with the fiber: the annotation is stale or wrong, say nothing.
    return all.length === nodes ? all : labels;
  }
  const lastUnknown = segments.findLastIndex((s) => "unknown" in s);
  const before = flat(segments.slice(0, firstUnknown));
  const after = flat(segments.slice(lastUnknown + 1));
  if (before.length + after.length > nodes) return labels;
  before.forEach((label, i) => (labels[i] = label));
  after.forEach((label, i) => (labels[nodes - after.length + i] = label));
  const middle = segments.slice(firstUnknown, lastUnknown + 1);
  const only = middle.length === 1 ? middle[0] : undefined;
  if (only && "unknown" in only)
    for (let i = before.length; i < nodes - after.length; i++) labels[i] = `${only.unknown} ›`;
  return labels;
}
/** A hook node's value, as its shape tells: state, effect, ref or memoized value. */
function hookValue(hook: unknown) {
  const state = field(hook, "memoizedState");
  const queue = field(hook, "queue");
  if (queue && typeof field(queue, "dispatch") === "function")
    return { kind: "state", value: preview(state) };
  if (typeof field(state, "create") === "function") return { kind: "effect", value: "effect" };
  if (state && typeof state === "object" && Object.keys(state).join() === "current")
    return { kind: "ref", value: `ref ${preview(field(state, "current"))}` };
  if (Array.isArray(state) && state.length === 2) return { kind: "memo", value: preview(state[0]) };
  return { kind: "value", value: preview(state) };
}
/** Each hook of a component with the variable it feeds, when the build recorded it. */
function hooks(fiber: Fiber): string[] {
  if (fiber.tag === TAG.class) return [`state: ${preview(fiber.memoizedState)}`];
  const nodes: unknown[] = [];
  for (let hook: unknown = fiber.memoizedState; hook; hook = field(hook, "next")) nodes.push(hook);
  const labels = hookLabels(fiberAnnotation(fiber), nodes.length);
  return nodes.slice(0, MAX_HOOKS).map((hook, i) => {
    const { kind, value } = hookValue(hook);
    const label = labels[i];
    if (kind === "effect") return label ? `${label}: effect` : "effect";
    // Inside a package's hook: its name, and what the node holds.
    if (label?.endsWith("›")) return `${label} ${kind}: ${value}`;
    return `${label ?? `${kind} #${i + 1}`}: ${value}`;
  });
}
const propsOf = (fiber: Fiber): Record<string, string> => {
  const props = fiber.memoizedProps;
  if (typeof props !== "object" || props === null) return {};
  return Object.fromEntries(
    Object.keys(props)
      .slice(0, MAX_PROPS)
      .map((key) => [key, preview(field(props, key))]),
  );
};
const changedKeys = (next: unknown, previous: unknown) => {
  if (next === previous) return [];
  if (typeof next !== "object" || next === null || typeof previous !== "object" || !previous)
    return ["*"];
  const keys = new Set([...Object.keys(next), ...Object.keys(previous)]);
  return [...keys].filter((key) => !Object.is(field(next, key), field(previous, key)));
};
/** The values of a function component's state hooks, in order. */
const stateValues = (fiber: Fiber) => {
  if (fiber.tag === TAG.class) return [fiber.memoizedState];
  const values: unknown[] = [];
  for (let hook: unknown = fiber.memoizedState; hook; hook = field(hook, "next"))
    if (field(hook, "queue")) values.push(field(hook, "memoizedState"));
  return values;
};
const contextValues = (fiber: Fiber) => {
  const values: unknown[] = [];
  let dependency = field(fiber.dependencies, "firstContext");
  while (dependency) {
    values.push(field(dependency, "memoizedValue"));
    dependency = field(dependency, "next");
  }
  return values;
};
const differs = (a: readonly unknown[], b: readonly unknown[]) =>
  a.length !== b.length || a.some((value, i) => !Object.is(value, b[i]));

/** Why a component rendered, and whether an equal-props memo would have skipped it. */
function reasonOf(fiber: Fiber) {
  const previous = alternate(fiber);
  if (!previous) return { reason: "mount", unnecessary: false };
  const props = changedKeys(fiber.memoizedProps, previous.memoizedProps);
  const state = differs(stateValues(fiber), stateValues(previous));
  const context = differs(contextValues(fiber), contextValues(previous));
  const reasons = [
    ...(props.length ? [`props: ${props.join(", ")}`] : []),
    ...(state ? ["state"] : []),
    ...(context ? ["context"] : []),
  ];
  return reasons.length
    ? { reason: reasons.join(" · "), unnecessary: false }
    : { reason: "parent", unnecessary: true };
}

export type Rendered = {
  id: number;
  rect: Rect | undefined;
  renders: number;
  unnecessary: boolean;
};
type Stats = { renders: number; renderedAt?: number; reason?: string; unnecessary?: boolean };

/**
 * Follows commits: counts each component's renders and why, and describes the tree on
 * demand. A fiber and its alternate are one instance: they share an id.
 */
export function createComponentTracker(now: () => number) {
  const ids = new WeakMap<Fiber, number>();
  const virtualIds = new Map<string, number>();
  const stats = new Map<number, Stats>();
  // The commit each fiber object was last seen current in. A subtree React skipped keeps
  // its fiber objects, and their flags from the render that made them: one seen in the
  // previous commit did not render in this one.
  const seen = new WeakMap<Fiber, number>();
  let commit = 0;
  let sequence = 0;
  const idOf = (fiber: Fiber) => {
    const other = alternate(fiber);
    const known = ids.get(fiber) ?? (other ? ids.get(other) : undefined);
    const id = known ?? ++sequence;
    ids.set(fiber, id);
    if (other) ids.set(other, id);
    return id;
  };
  const virtualId = (fiberId: number, index: number) => {
    const key = `${fiberId}:${index}`;
    const known = virtualIds.get(key);
    if (known) return known;
    const id = ++sequence;
    virtualIds.set(key, id);
    return id;
  };

  /** Records one commit; returns the components that rendered in it. */
  function onCommit(root: unknown): Rendered[] {
    const current = rootFiber(root);
    if (!current) return [];
    const previousCommit = commit++;
    const rendered: Rendered[] = [];
    const at = now();
    const visit = (fiber: Fiber) => {
      if (COMPOSITE.has(fiber.tag)) {
        const lastSeen = seen.get(fiber);
        const didRender =
          lastSeen !== previousCommit &&
          (alternate(fiber) === null
            ? lastSeen === undefined
            : (fiber.flags & PERFORMED_WORK) !== 0);
        if (didRender) {
          const id = idOf(fiber);
          const { reason, unnecessary } = reasonOf(fiber);
          const entry = stats.get(id) ?? { renders: 0 };
          const next = { renders: entry.renders + 1, renderedAt: at, reason, unnecessary };
          stats.set(id, next);
          rendered.push({ id, rect: hostRect(fiber), renders: next.renders, unnecessary });
        }
      }
      seen.set(fiber, previousCommit + 1);
      for (let c = child(fiber); c; c = sibling(c)) visit(c);
    };
    visit(current);
    return rendered;
  }

  /** The component tree of `root` now: composites, Suspense and Server Components. */
  function describe(root: unknown): ComponentNode[] {
    const current = rootFiber(root);
    if (!current) return [];
    const nodes: ComponentNode[] = [];
    const walk = (fiber: Fiber, parent: number | null, depth: number) => {
      let owner = parent;
      let level = depth;
      const fiberId = COMPOSITE.has(fiber.tag) || fiber.tag === TAG.suspense ? idOf(fiber) : 0;
      // Flight attaches the Server Components that produced an element to its fiber.
      serverComponents(fiber).forEach((info, index) => {
        const id = virtualId(fiberId || idOf(fiber), index);
        nodes.push({
          id,
          parent: owner,
          depth: level,
          name: info.name,
          kind: "server",
          key: info.key,
          env: info.env,
          renders: 0,
        });
        owner = id;
        level++;
      });
      if (fiberId) {
        const entry = stats.get(fiberId);
        nodes.push({
          id: fiberId,
          parent: owner,
          depth: level,
          name: fiberName(fiber),
          source: fiberAnnotation(fiber)?.source,
          file: fiberAnnotation(fiber)?.file,
          kind: "client",
          key: fiber.key ?? undefined,
          renders: entry?.renders ?? 0,
          renderedAt: entry?.renderedAt,
          reason: entry?.reason,
          unnecessary: entry?.unnecessary,
          props: propsOf(fiber),
          hooks: fiber.tag === TAG.suspense ? [] : hooks(fiber),
          rect: hostRect(fiber),
        });
        owner = fiberId;
        level++;
      }
      for (let c = child(fiber); c; c = sibling(c)) walk(c, owner, level);
    };
    walk(current, null, 0);
    return nodes;
  }

  /** The screen box of a component by id, if it is still mounted in `root`. */
  function rectById(root: unknown, id: number): Rect | undefined {
    const current = rootFiber(root);
    let found: Rect | undefined;
    const walk = (fiber: Fiber): boolean => {
      if (ids.get(fiber) === id) {
        found = hostRect(fiber);
        return true;
      }
      for (let c = child(fiber); c; c = sibling(c)) if (walk(c)) return true;
      return false;
    };
    if (current) walk(current);
    return found;
  }

  return { onCommit, describe, rectById };
}

/** The preloaded hook's channel, if the Client was started with it (hook.ts). */
export function fiberChannel(): FiberChannel | undefined {
  const channel: unknown = globalThis.__AIRTTY_FIBERS__;
  return typeof channel === "object" &&
    channel !== null &&
    field(channel, "version") === 1 &&
    typeof field(channel, "subscribe") === "function"
    ? globalThis.__AIRTTY_FIBERS__
    : undefined;
}
