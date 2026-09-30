import ts from "@typescript/typescript6";
import { basename, dirname, extname, relative as relativeTo } from "node:path";

/**
 * What the build tells the runtime about each component and custom hook of a module, for
 * the DevTools and React's own messages: the name its author gave it (the bundler renames
 * colliding identifiers: every page's `Page` becomes `Page2`, `Page3`…), where it is
 * defined, and the variables its hooks are assigned to.
 *
 * Hook names come from the source, by annotation, rather than React DevTools' way (render
 * the component again under a recording dispatcher, map each hook's stack frame through
 * source maps, parse the file at that line): annotating costs one AST walk per module at
 * build time and nothing at runtime, never re-runs application code, and needs no source
 * map library. Its limit is a library's custom hook, whose inner hooks it cannot count;
 * the DevTools then name what comes before and after it, and number the rest.
 */

/** A hook call in a component or custom hook: the called name, and the variable it feeds. */
type HookCall = { callee: string; binding: string | undefined; local: boolean };
type Entry = {
  /** The expression that refers to it at the end of the module. */
  ref: string;
  name: string;
  line: number;
  kind: "component" | "hook";
  hooks: HookCall[];
};

const ROUTE_KINDS: Record<string, string> = {
  page: "Page",
  layout: "Layout",
  loading: "Loading",
  error: "Error",
  "not-found": "NotFound",
};
const DEFAULT_REF = "__lucioleDefault";
/** The framework's sources: shown as `luciole/<file>`, not as a path climbing out of the app. */
const FRAMEWORK = dirname(import.meta.path);
const MAX_BINDING_NAMES = 3;
const pascal = (text: string) =>
  text
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((word) => word[0]?.toUpperCase() + word.slice(1))
    .join("");

/**
 * The name of a route file's component when its own is absent or generic (`Page`): its
 * segments and kind, `app/notes/[id]/page.tsx` → `NotesIdPage`, `app/layout.tsx` →
 * `RootLayout`, `app/page.tsx` → `HomePage`. Groups `(g)` do not count.
 */
export function routeComponentName(relative: string): string | undefined {
  const parts = relative.split("/");
  if (parts[0] !== "app") return undefined;
  const kind = ROUTE_KINDS[basename(relative, extname(relative))];
  if (!kind) return undefined;
  const segments = parts
    .slice(1, -1)
    .filter((segment) => !segment.startsWith("("))
    .map((segment) => pascal(segment.replaceAll(/[[\].]/g, "")));
  return `${segments.join("") || (kind === "Page" ? "Home" : "Root")}${kind}`;
}

const isComponentName = (name: string) => /^[A-Z]/.test(name);
const isHookName = (name: string) => /^use[A-Z0-9]/.test(name);
const unwrap = (node: ts.Node): ts.Node =>
  ts.isParenthesizedExpression(node) ||
  ts.isAsExpression(node) ||
  ts.isNonNullExpression(node) ||
  ts.isSatisfiesExpression(node) ||
  ts.isAwaitExpression(node)
    ? unwrap(node.parent)
    : node;
/** `const [draft, setDraft] = useState()` → `draft`; `const { a, b } = useX()` → `a, b`. */
function bindingOf(call: ts.CallExpression): string | undefined {
  const holder = unwrap(call.parent);
  if (!ts.isVariableDeclaration(holder)) return undefined;
  const name = holder.name;
  if (ts.isIdentifier(name)) return name.text;
  const names = name.elements.flatMap((element) =>
    ts.isBindingElement(element) && ts.isIdentifier(element.name) ? [element.name.text] : [],
  );
  if (ts.isArrayBindingPattern(name)) return names[0];
  return names.slice(0, MAX_BINDING_NAMES).join(", ") || undefined;
}
const calleeName = (call: ts.CallExpression) =>
  ts.isIdentifier(call.expression)
    ? call.expression.text
    : ts.isPropertyAccessExpression(call.expression)
      ? call.expression.name.text
      : undefined;
/**
 * The hooks a function calls, in evaluation order: a call's arguments run before it, and a
 * nested function (a callback, an effect) is not the component's own body.
 */
function hookCalls(body: ts.Node, moduleScope: ReadonlySet<string>): HookCall[] {
  const calls: HookCall[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isFunctionLike(node) && node !== body) return;
    ts.forEachChild(node, visit);
    if (!ts.isCallExpression(node)) return;
    const callee = calleeName(node);
    if (!callee || !isHookName(callee)) return;
    calls.push({
      callee,
      binding: bindingOf(node),
      local: ts.isIdentifier(node.expression) && moduleScope.has(callee),
    });
  };
  visit(body);
  return calls;
}
/** The function a component or hook declaration wraps: itself, or `memo(fn)`'s `fn`. */
function functionOf(node: ts.Expression | undefined): ts.FunctionLikeDeclaration | undefined {
  if (!node) return undefined;
  if (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) return node;
  if (ts.isCallExpression(node)) return functionOf(node.arguments[0]);
  return undefined;
}
function moduleScopeOf(file: ts.SourceFile) {
  const names = new Set<string>();
  for (const statement of file.statements) {
    if (ts.isImportDeclaration(statement)) {
      const clause = statement.importClause;
      if (clause?.name) names.add(clause.name.text);
      const bindings = clause?.namedBindings;
      if (bindings && ts.isNamedImports(bindings))
        for (const element of bindings.elements) names.add(element.name.text);
      if (bindings && ts.isNamespaceImport(bindings)) names.add(bindings.name.text);
    }
    if ((ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)) && statement.name)
      names.add(statement.name.text);
    if (ts.isVariableStatement(statement))
      for (const declaration of statement.declarationList.declarations)
        if (ts.isIdentifier(declaration.name)) names.add(declaration.name.text);
  }
  return names;
}

/**
 * `text` with its components and custom hooks annotated. Every edit keeps lines where they
 * were, so source maps and the recorded lines agree: an anonymous default export gains a
 * name on its own line, the annotations go after the last line.
 */
export function annotateNames(
  text: string,
  { path, relative, runtime }: { path: string; relative: string; runtime: string },
) {
  const file = ts.createSourceFile(path, text, ts.ScriptTarget.ESNext, true);
  const scope = moduleScopeOf(file);
  const route = routeComponentName(relative);
  // What the DevTools show, and, for a file outside the application, the absolute path
  // they open (inside, `relative` joined to the application's root).
  const label = path.startsWith(`${FRAMEWORK}/`)
    ? `luciole/${relativeTo(FRAMEWORK, path)}`
    : relative;
  const absolute = relative.startsWith("..") ? path : null;
  // The name a route file's default export often has, the same in every route: `Page`.
  const generic = ROUTE_KINDS[basename(relative, extname(relative))];
  const entries: Entry[] = [];
  const edits: { at: number; end: number; text: string }[] = [];
  let exportDefault = false;
  const line = (node: ts.Node) => file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1;
  const add = (
    ref: string,
    local: string | undefined,
    fn: ts.Node | undefined,
    node: ts.Node,
    isDefault: boolean,
  ) => {
    const kind = local && isHookName(local) ? "hook" : "component";
    const unnamed = local === undefined || !isComponentName(local) || local === generic;
    const name =
      isDefault && route && kind === "component" && unnamed
        ? route
        : (local ?? pascal(basename(relative, extname(relative))));
    if (kind === "component" && !isComponentName(name)) return;
    entries.push({ ref, name, line: line(node), kind, hooks: fn ? hookCalls(fn, scope) : [] });
  };
  const isDefaultExport = (node: ts.Node) =>
    ts.canHaveModifiers(node) &&
    (ts.getModifiers(node)?.some((m) => m.kind === ts.SyntaxKind.DefaultKeyword) ?? false);
  for (const statement of file.statements) {
    if (ts.isFunctionDeclaration(statement) && statement.body) {
      const isDefault = isDefaultExport(statement);
      const local = statement.name?.text;
      if (!local && !isDefault) continue;
      if (!local) {
        // `export default function () {}`: named, so the end of the module can refer to it.
        const keyword = statement
          .getChildren(file)
          .find((c) => c.kind === ts.SyntaxKind.FunctionKeyword);
        const star = statement.asteriskToken;
        const after = (star ?? keyword)?.end;
        if (after === undefined) continue;
        edits.push({ at: after, end: after, text: ` ${DEFAULT_REF}` });
      }
      if (local && !isComponentName(local) && !isHookName(local) && !(isDefault && route)) continue;
      add(local ?? DEFAULT_REF, local, statement, statement, isDefault);
    } else if (ts.isClassDeclaration(statement)) {
      const local = statement.name?.text;
      if (local && isComponentName(local))
        add(local, local, undefined, statement, isDefaultExport(statement));
    } else if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (!ts.isIdentifier(declaration.name)) continue;
        const local = declaration.name.text;
        const fn = functionOf(declaration.initializer);
        if (fn && (isComponentName(local) || isHookName(local)))
          add(local, local, fn, declaration, false);
      }
    } else if (ts.isExportAssignment(statement) && !statement.isExportEquals) {
      const expression = statement.expression;
      if (ts.isIdentifier(expression)) {
        // Already annotated under its own name; a generic route name gets the route's.
        const known = entries.find((e) => e.ref === expression.text);
        if (known && route && known.name === generic) known.name = route;
        continue;
      }
      const fn =
        functionOf(expression) ?? (ts.isClassExpression(expression) ? expression : undefined);
      if (!fn) continue;
      // `export default <expression>` → `const __lucioleDefault = <expression>`, exported at the end.
      edits.push({
        at: statement.getStart(file),
        end: expression.getStart(file),
        text: `const ${DEFAULT_REF} = `,
      });
      exportDefault = true;
      const named =
        ts.isFunctionExpression(fn) || ts.isClassExpression(fn) ? fn.name?.text : undefined;
      add(DEFAULT_REF, named, ts.isClassExpression(fn) ? undefined : fn, statement, true);
    }
  }
  if (!entries.length) return text;
  let out = text;
  for (const edit of edits.toSorted((a, b) => b.at - a.at))
    out = out.slice(0, edit.at) + edit.text + out.slice(edit.end);
  const hooks = (calls: readonly HookCall[]) =>
    `[${calls.map((c) => `[${c.local && isHookName(c.callee) && !PRIMITIVE_HOOKS.has(c.callee) ? c.callee : JSON.stringify(c.callee)},${JSON.stringify(c.callee)},${JSON.stringify(c.binding ?? null)}]`).join(",")}]`;
  // One statement per entry: a reference that fails (a hook bound in a nested scope)
  // loses its own annotation only.
  const annotations = entries.map(
    (e) =>
      `try{__lucioleAnnotate(${e.ref},${JSON.stringify(e.kind === "component" ? e.name : null)},${JSON.stringify(`${label}:${e.line}`)},${hooks(e.hooks)},${JSON.stringify(absolute)})}catch{}`,
  );
  return `${out}\n${exportDefault ? `export default ${DEFAULT_REF};\n` : ""}import {annotate as __lucioleAnnotate} from ${JSON.stringify(runtime)};\n${annotations.join("\n")}\n`;
}

/** React's own hooks: counted by the DevTools, never referenced (they carry no annotation). */
const PRIMITIVE_HOOKS = new Set([
  "useState",
  "useReducer",
  "useRef",
  "useMemo",
  "useCallback",
  "useEffect",
  "useLayoutEffect",
  "useInsertionEffect",
  "useImperativeHandle",
  "useId",
  "useDeferredValue",
  "useSyncExternalStore",
  "useTransition",
  "useOptimistic",
  "useActionState",
  "useContext",
  "useDebugValue",
  "useEffectEvent",
]);
