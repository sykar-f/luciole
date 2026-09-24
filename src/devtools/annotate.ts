/**
 * Called by the code src/build-names.ts appends to each module: sets `displayName`
 * (unless the author did) and `__airtty` on a component or custom hook, and records the
 * component's source by name for the Server's DevTools agent (Flight tells the Client a
 * Server Component's name, not its file). Read by src/devtools/fibers.ts.
 */
export type HookRef = readonly [ref: unknown, callee: string, binding: string | null];
/** `source` is shown (`app/page.tsx:3`, `airtty/fields.tsx:76`); `file` is opened when set. */
export type Annotation = { source: string; hooks: readonly HookRef[]; file?: string };
declare global {
  var __AIRTTY_SOURCES__: Map<string, string> | undefined;
}
export function annotate(
  target: unknown,
  name: string | null,
  source: string,
  hooks: readonly HookRef[],
  file: string | null = null,
) {
  if (typeof target !== "function" && (typeof target !== "object" || target === null)) return;
  if (name && !Object.hasOwn(target, "displayName"))
    Object.defineProperty(target, "displayName", {
      value: name,
      configurable: true,
      writable: true,
    });
  const annotation: Annotation = { source, hooks, ...(file ? { file } : {}) };
  Object.defineProperty(target, "__airtty", { value: annotation, configurable: true });
  if (name) (globalThis.__AIRTTY_SOURCES__ ??= new Map()).set(name, source);
}
