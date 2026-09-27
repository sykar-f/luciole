import ts from "@typescript/typescript6";
import { basename, resolve, relative, dirname, join } from "node:path";
import { mkdir, readFile, readdir, rename, rm, realpath } from "node:fs/promises";
import { readFileSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { z } from "zod";
import { bundleMessages, logMessages } from "./bundle-errors";
import { nativePackage } from "./native";
import { airttySources } from "./sources";
import { governingLock } from "./lockfile";
import { withLock } from "./launcher/lock";
import { readJsonFile } from "./package-json";
import { ROUTE_TREE_FILE, compileRouteGraph, renderRouteTree } from "./route-graph";
import { cachedFunctions, cacheSource, staleTimeOf } from "./cache/transform";
import { annotateNames } from "./build-names";
import { ABI_KEY, APP_MANIFEST, isAbiSpecifier, type AppManifest } from "./abi";
import { readAppDeclaration, writeAppMetadata, type AppArgs } from "./app-metadata";
import { isArgsDefinition } from "./args";
import { undeclaredUses, type Capabilities } from "./capabilities";
import { signManifest, type PublisherKey } from "./publisher";
import {
  copyWebServerFiles,
  transformAsyncContext,
  WEB_SERVER_FILE,
  WEB_SERVER_SETUP,
  webServerPlugins,
} from "./web/server-build";
// airtty's src/, even when this module runs bundled into an application (src/sources.ts).
const framework = airttySources(dirname(import.meta.path));
const quote = JSON.stringify;
// Resolved from the framework so starters using a file: dependency find their copy.
const tanstackClientBuild = join(
  dirname(Bun.resolveSync("@tanstack/router-core/isServer", framework)),
  "client.js",
);
type Module = {
  path: string;
  text: string;
  ast: ts.SourceFile;
  directive: string;
  imports: { name: string; node: ts.Node; path?: string }[];
  exports: string[];
  actionExports: string[];
  /** Functions `"use cache"` wraps on the Server (src/cache/transform.ts). */
  cached: string[];
};
const ROUTE_AUTH = ["public", "required"] as const;
type RouteAuth = (typeof ROUTE_AUTH)[number];
const PackageImports = z.object({ imports: z.unknown() });
/**
 * Every target a subpath import can resolve to, whatever the conditions (Node's `imports`:
 * an exact key, or one `*` pattern), or `undefined` when no key matches.
 */
function subpathTargets(imports: unknown, name: string): string[] | undefined {
  if (typeof imports !== "object" || imports === null) return undefined;
  const leaves = (value: unknown, star: string): string[] =>
    typeof value === "string"
      ? [value.replaceAll("*", star)]
      : Array.isArray(value)
        ? value.flatMap((v) => leaves(v, star))
        : typeof value === "object" && value !== null
          ? Object.values(value).flatMap((v) => leaves(v, star))
          : [];
  const entries = Object.entries(imports);
  const exact = entries.find(([key]) => key === name);
  if (exact) return leaves(exact[1], "");
  // The longest prefix wins, as in Node.
  const patterns = entries.sort(([a], [b]) => b.indexOf("*") - a.indexOf("*"));
  for (const [key, value] of patterns) {
    const [prefix, suffix, extra] = key.split("*");
    if (prefix === undefined || suffix === undefined || extra !== undefined) continue;
    if (name.length >= key.length - 1 && name.startsWith(prefix) && name.endsWith(suffix))
      return leaves(value, name.slice(prefix.length, name.length - suffix.length));
  }
  return undefined;
}
function bundleFailure(error: unknown): never {
  throw new Error(bundleMessages(error).join("\n"));
}
// Bun reports top-level await in a CommonJS bundle as an `await` outside an async
// function: the application bundle's format cannot express it (docs/EMBEDDING.md).
const BundleErrors = z.object({
  errors: z.array(
    z.object({
      message: z.string(),
      position: z.object({ file: z.string(), line: z.number() }).nullish(),
    }),
  ),
});
/** Where Client code awaits at top level, as `file:line`, when that is why Bun failed. */
function topLevelAwait(root: string, error: unknown) {
  const parsed = BundleErrors.safeParse(error);
  const found = parsed.success
    ? parsed.data.errors.find((e) => e.message.includes('"await" can only be used inside'))
    : undefined;
  return found?.position
    ? `${relative(root, found.position.file)}:${found.position.line}`
    : undefined;
}
export type BuildOptions = {
  /**
   * The application bundle (`.airtty/app`, what hosts embed): `"auto"` (default) skips it,
   * with a warning, when Client code awaits at top level, which CommonJS cannot express;
   * `"required"` (`airtty build --app-bundle`) fails the build instead.
   */
  appBundle?: "auto" | "required";
  /**
   * Signs the bundle's manifest with this publisher key (`airtty build --sign-bundle`,
   * src/publisher.ts). Implies `appBundle: "required"`: nothing to sign otherwise.
   */
  signBundle?: PublisherKey;
  /**
   * Also builds the Server for the browser (`.airtty/web-server/server-worker.js`, `airtty
   * build --web-local`): the same entry, run by a Worker (docs/WEB.md, step 3).
   */
  webServer?: boolean;
};
/**
 * `.airtty/app/manifest.json`: the bundle's identity, ABI and hash, the built-ins it
 * requires and the capabilities the application declares, compared with those built-ins.
 * Signed with the publisher's key when the build is asked to (src/publisher.ts).
 */
async function writeAppManifest(
  root: string,
  directory: string,
  {
    buildId,
    builtins,
    capabilities,
    publisher,
  }: {
    buildId: string;
    builtins: string[];
    /** `airtty.capabilities` of the application's package.json (decision 3): optional. */
    capabilities?: Capabilities;
    publisher?: PublisherKey;
  },
) {
  const code = await readFile(join(directory, "index.cjs"), "utf8");
  // Declaring is a claim the host shows before opening the application: one the Client
  // code visibly exceeds is reported. An application that declares nothing claims nothing.
  if (capabilities)
    for (const use of undeclaredUses(builtins, capabilities))
      console.warn(
        `airtty build: ${basename(root)}: Client code requires ${use.builtin} but airtty.capabilities does not declare ${use.capability}`,
      );
  const manifest: AppManifest = {
    format: 1,
    name: basename(root),
    buildId,
    abi: ABI_KEY,
    bundle: "index.cjs",
    sha256: createHash("sha256").update(code).digest("hex"),
    size: Buffer.byteLength(code),
    builtins,
    capabilities,
  };
  await Bun.write(
    join(directory, APP_MANIFEST),
    JSON.stringify(publisher ? signManifest(manifest, publisher) : manifest, null, 2),
  );
}
/** `name` or `@scope/name`: the directories a package owns below `node_modules/`. */
const packageDepth = (name: string) => (name.startsWith("@") ? 2 : 1);
// Files under 64 levels of packages are a cycle, not an import chain.
const MAX_CHAIN = 64;
const BUILD_ID_LENGTH = 24;
const InstalledPackage = z.object({ version: z.string() });
// The public entries of the framework package, as `airtty/<entry>` imports name them.
const FRAMEWORK_ENTRIES = new Map([
  ["client", "client.tsx"],
  ["server", "server.ts"],
  ["route-tree", "route-tree.tsx"],
  ["args", "args.ts"],
  ["grammars", "grammars.ts"],
]);
/** Where an application declares its command-line arguments. */
export const ARGS_FILE = "app/args.ts";
/**
 * The arguments module just bundled, evaluated: its flags checked (reserved names,
 * supported shapes) and described for metadata.json, which hosts read without running it.
 */
async function readArgs(bundle: string, root: string): Promise<AppArgs> {
  // Absolute: a relative path would be resolved as a package name.
  const imported: unknown = await import(resolve(bundle));
  const definition =
    typeof imported === "object" && imported !== null && "default" in imported
      ? imported.default
      : undefined;
  if (!isArgsDefinition(definition))
    throw new Error(`${relative(root, join(root, ARGS_FILE))}: export default defineArgs({...})`);
  definition.flags();
  return {
    summary: definition.summary,
    examples: definition.examples ? [...definition.examples] : undefined,
    schema: definition.jsonSchema(),
  };
}
/** `@scope/name/sub` → `@scope/name`; `name/sub` → `name`. */
const packageOf = (specifier: string) =>
  specifier.split("/").slice(0, packageDepth(specifier)).join("/");
/**
 * Optional `airtty.json`: `serverPackages` names third-party packages that must never
 * reach the Client although they do not import `server-only` themselves.
 */
const Config = z.object({
  serverPackages: z
    .array(
      z
        .string()
        .min(1)
        .refine((name) => packageOf(name) === name, "must be a package name, not a subpath"),
      { error: "serverPackages must list package names" },
    )
    .default([]),
});
async function readConfig(root: string) {
  const file = Bun.file(join(root, "airtty.json"));
  if (!(await file.exists())) return { serverPackages: new Set<string>() };
  let config: unknown;
  try {
    config = JSON.parse(await file.text());
  } catch {
    throw new Error("airtty.json: invalid JSON");
  }
  const parsed = Config.safeParse(config);
  if (!parsed.success) throw new Error(`airtty.json: ${z.prettifyError(parsed.error)}`);
  return { serverPackages: new Set(parsed.data.serverPackages) };
}
// Installed package owning `file`: the segment after its last `node_modules/`.
function packageOfFile(file: string) {
  const parts = file.split("/");
  const at = parts.lastIndexOf("node_modules");
  if (at < 0 || at + 1 >= parts.length) return undefined;
  const end = at + 1 + packageDepth(parts[at + 1]);
  return { name: parts.slice(at + 1, end).join("/"), dir: parts.slice(0, end).join("/") };
}
/**
 * Builds `directory` into `output`. Concurrent builds of one output (two launches, two
 * `airtty dev`) take turns on a lock next to it; a build whose identity and options match
 * the output already there leaves it untouched, so a second launch never swaps directories
 * under the first one's feet.
 */
export async function build(
  directory: string,
  output = join(directory, ".airtty"),
  options: BuildOptions = {},
) {
  await mkdir(dirname(output), { recursive: true });
  return await withLock(`${output}-lock`, () => buildUnlocked(directory, output, options), {
    waiting: () => console.error(`airtty build: waiting for another build of ${output}`),
  });
}
const ReactExports = z.object({
  exports: z.object({ ".": z.object({ "react-server": z.string(), default: z.string() }) }),
});
/**
 * What React exports to Client code and not to the Server (`useState`, `useEffect`,
 * `createContext`…), read from the React the application resolves: a Server Component
 * importing one builds, then its Server dies at start on a missing export. Empty when
 * React's layout is not the one expected: the check is then skipped, not guessed.
 */
function clientOnlyReactExports(root: string): ReadonlySet<string> {
  try {
    // The application's React, or the framework's when it has none of its own (a
    // starter elsewhere builds against the framework's installation).
    let manifest: string;
    try {
      manifest = Bun.resolveSync("react/package.json", root);
    } catch {
      manifest = Bun.resolveSync("react/package.json", framework);
    }
    const entries = ReactExports.parse(JSON.parse(readFileSync(manifest, "utf8"))).exports["."];
    const load = createRequire(manifest);
    const keys = (entry: string): string[] => {
      const loaded: unknown = load(join(dirname(manifest), entry));
      return typeof loaded === "object" && loaded !== null ? Object.keys(loaded) : [];
    };
    const server = new Set(keys(entries["react-server"]));
    return new Set(keys(entries.default).filter((name) => !server.has(name)));
  } catch {
    return new Set();
  }
}
/** An application import that names no file: reported at the import (`fail`). */
class Unresolved extends Error {
  constructor(from: string, name: string) {
    super(`${from}: Cannot resolve ${name}`);
  }
}
// A signed bundle needs a publisher key: hosts that sign their own builds (studio) make one.
export {
  fingerprintOf,
  generatePublisherKey,
  readPublisherKey,
  type PublisherKey,
} from "./publisher";

/** What a build was asked for beyond its sources: an output built otherwise is rebuilt. */
const BuiltWith = z.object({
  buildId: z.string(),
  options: z.object({
    appBundle: z.enum(["auto", "required"]),
    webServer: z.boolean(),
    signed: z.boolean(),
  }),
});
async function upToDate(
  output: string,
  buildId: string,
  options: z.infer<typeof BuiltWith>["options"],
) {
  try {
    const built = BuiltWith.safeParse(
      JSON.parse(await readFile(join(output, "manifest.json"), "utf8")),
    );
    return (
      built.success &&
      built.data.buildId === buildId &&
      built.data.options.appBundle === options.appBundle &&
      built.data.options.webServer === options.webServer &&
      built.data.options.signed === options.signed
    );
  } catch {
    return false;
  }
}
async function buildUnlocked(
  directory: string,
  output: string,
  { appBundle: wanted = "auto", signBundle, webServer = false }: BuildOptions,
) {
  const appBundle = signBundle ? "required" : wanted;
  const root = await realpath(directory),
    modules = new Map<string, Module>();
  const { serverPackages } = await readConfig(root);
  const clientOnlyReact = clientOnlyReactExports(root);
  // Checked before the long part: a wrong icon or capability fails at once.
  const declaration = await readAppDeclaration(root);
  // How each module was first reached, per graph: boundary errors show the whole chain.
  const serverParent = new Map<string, string>(),
    clientParent = new Map<string, string>();
  const display = (file: string) => {
    const owner = packageOfFile(file);
    return owner ? owner.name + file.slice(owner.dir.length) : relative(root, file);
  };
  const graphChain = (parents: Map<string, string>, file: string) => {
    const chain = [file];
    for (let p = parents.get(file); p && !chain.includes(p); p = parents.get(p)) chain.unshift(p);
    return chain;
  };
  // A Client chain starts at the page that rendered its "use client" boundary.
  const clientChain = (file: string) => {
    const chain = graphChain(clientParent, file);
    return [...graphChain(serverParent, chain[0]).slice(0, -1), ...chain];
  };
  const via = (chain: readonly string[]) => `\n  via ${chain.map(display).join(" → ")}`;
  // A declaration, not an arrow: TypeScript narrows only after calls to declared `never`s.
  function fail(m: Module, n: ts.Node, message: string): never {
    failAt(m, n.getStart(m.ast), message);
  }
  function failAt(m: Module, position: number, message: string): never {
    const p = m.ast.getLineAndCharacterOfPosition(position);
    throw new Error(`${relative(root, m.path)}:${p.line + 1}:${p.character + 1}: ${message}`);
  }
  const moduleAt = (path: string) => {
    const m = modules.get(path);
    if (!m) throw new Error(`Module read without its source: ${path}`);
    return m;
  };
  async function file(from: string, base: string, name: string) {
    for (const candidate of [
      base,
      ...[".ts", ".tsx", ".js", ".jsx", "/index.ts", "/index.tsx"].map((s) => base + s),
    ]) {
      if (await Bun.file(candidate).exists()) return await realpath(candidate);
    }
    throw new Unresolved(from, name);
  }
  /**
   * The application's files an import names: none for a package, one for a relative path,
   * and for a subpath import (`#name`, package.json `imports`) the target of every
   * condition, since each role's bundle picks its own (the browser's Server, the Server).
   */
  async function local(from: string, name: string): Promise<string[]> {
    if (name.startsWith(".")) return [await file(from, resolve(dirname(from), name), name)];
    if (!name.startsWith("#")) return [];
    const scope = await packageScope(from);
    const targets = scope ? subpathTargets(scope.imports, name) : undefined;
    if (!scope || !targets) throw new Unresolved(from, name);
    const files: string[] = [];
    for (const target of targets)
      if (target.startsWith("./")) files.push(await file(from, resolve(scope.dir, target), name));
    return [...new Set(files)];
  }
  /** The package.json `imports` that govern `from`: the nearest package.json, in the app. */
  async function packageScope(from: string) {
    for (let dir = dirname(from); dir === root || dir.startsWith(`${root}/`); dir = dirname(dir)) {
      const manifest = Bun.file(join(dir, "package.json"));
      if (!(await manifest.exists())) continue;
      const parsed = PackageImports.safeParse(await manifest.json());
      return { dir, imports: parsed.success ? parsed.data.imports : undefined };
    }
    return undefined;
  }
  async function read(path: string): Promise<Module> {
    const existing = modules.get(path);
    if (existing) return existing;
    const text = await readFile(path, "utf8"),
      ast = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true);
    const m: Module = {
      path,
      text,
      ast,
      directive: "",
      imports: [],
      exports: [],
      actionExports: [],
      cached: [],
    };
    modules.set(path, m);
    // The public way to the parser's diagnostics: `ast` keeps them in an internal field.
    const [error] =
      ts.transpileModule(text, { fileName: path, reportDiagnostics: true }).diagnostics ?? [];
    // At the diagnostic's own position: the file's start would send a reader to line 1.
    if (error) failAt(m, error.start ?? 0, ts.flattenDiagnosticMessageText(error.messageText, " "));
    for (const s of ast.statements) {
      if (ts.isExpressionStatement(s) && ts.isStringLiteral(s.expression)) {
        if (["use client", "use server", "use cache"].includes(s.expression.text)) {
          if (m.directive && m.directive !== s.expression.text)
            fail(m, s, "Conflicting directives");
          m.directive = s.expression.text;
        }
      } else break;
    }
    function visit(n: ts.Node) {
      if (
        ts.isExpressionStatement(n) &&
        ts.isStringLiteral(n.expression) &&
        n.expression.text === "use server" &&
        n.parent !== ast
      )
        fail(
          m,
          n,
          'Inline Server Functions and closure captures are unsupported; export an async function from a "use server" module',
        );
      if (
        (ts.isImportDeclaration(n) || ts.isExportDeclaration(n)) &&
        n.moduleSpecifier &&
        ts.isStringLiteral(n.moduleSpecifier)
      ) {
        if (ts.isImportDeclaration(n) && n.importClause?.isTypeOnly) return;
        if (ts.isExportDeclaration(n) && n.isTypeOnly) return;
        m.imports.push({ name: n.moduleSpecifier.text, node: n });
      }
      if (
        ts.isCallExpression(n) &&
        (n.expression.kind === ts.SyntaxKind.ImportKeyword ||
          (ts.isIdentifier(n.expression) && n.expression.text === "require"))
      )
        fail(m, n, "Dynamic imports/require in application sources are unsupported in MVP");
      ts.forEachChild(n, visit);
    }
    visit(ast);
    m.cached = cachedFunctions(ast, m.directive, (n, message) => fail(m, n, message));
    const resolved: Module["imports"] = [];
    for (const i of m.imports) {
      let paths: string[];
      try {
        paths = await local(path, i.name);
      } catch (error: unknown) {
        // At the import that names it, so the reader sees which line to fix.
        if (error instanceof Unresolved) fail(m, i.node, `Cannot resolve ${i.name}`);
        throw error;
      }
      resolved.push(...(paths.length ? paths.map((p) => ({ ...i, path: p })) : [i]));
    }
    m.imports = resolved;
    for (const i of m.imports) if (i.path) await read(i.path);
    return m;
  }
  const inventory: string[] = [];
  async function walk(dir: string) {
    for (const e of await readdir(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) await walk(p);
      else if (
        ["page.tsx", "layout.tsx", "loading.tsx", "error.tsx", "not-found.tsx"].includes(e.name)
      )
        inventory.push(relative(root, p));
    }
  }
  await walk(join(root, "app"));
  const graph = compileRouteGraph(inventory);
  const abs = (p: string) => join(root, p);
  const pages = graph.pages.map((r) => abs(r.file));
  const layouts = [graph.root, ...graph.layouts.map((l) => l.file)].map(abs);
  // Rendered by the Client alone: while a page loads, when it fails, when it is missing.
  const loadings = [
    ...new Set([...graph.pages.flatMap((r) => [r.loading, r.error, r.notFound]), graph.notFound]),
  ]
    .filter((file): file is string => !!file)
    .map(abs);
  const authFile = join(root, "server/auth.ts");
  const hasAuth = await Bun.file(authFile).exists();
  // Optional like server/auth.ts: its default export is the "use cache" CacheHandler.
  const cacheFile = join(root, "server/cache.ts");
  const hasCache = await Bun.file(cacheFile).exists();
  // Optional too: the application's command-line arguments (src/args.ts).
  const argsFile = join(root, ARGS_FILE);
  const hasArgs = await Bun.file(argsFile).exists();
  for (const p of [
    ...pages,
    ...layouts,
    ...loadings,
    ...(hasAuth ? [authFile] : []),
    ...(hasCache ? [cacheFile] : []),
    ...(hasArgs ? [argsFile] : []),
  ])
    await read(p);
  const program = ts.createProgram([...modules.keys()], {
    allowJs: true,
    jsx: ts.JsxEmit.ReactJSX,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    module: ts.ModuleKind.ESNext,
    skipLibCheck: true,
  });
  const checker = program.getTypeChecker();
  function moduleAuth(m: Module): RouteAuth {
    let value: RouteAuth = "required";
    for (const statement of m.ast.statements) {
      if (!ts.isVariableStatement(statement)) continue;
      const exported = statement.modifiers?.some((x) => x.kind === ts.SyntaxKind.ExportKeyword);
      if (!exported) continue;
      for (const declaration of statement.declarationList.declarations) {
        if (!ts.isIdentifier(declaration.name) || declaration.name.text !== "auth") continue;
        let initializer = declaration.initializer;
        while (
          initializer &&
          (ts.isAsExpression(initializer) ||
            ts.isSatisfiesExpression(initializer) ||
            ts.isParenthesizedExpression(initializer))
        )
          initializer = initializer.expression;
        const text = initializer && ts.isStringLiteral(initializer) ? initializer.text : undefined;
        const auth = ROUTE_AUTH.find((a) => a === text);
        if (!auth) fail(m, declaration, 'auth must be the literal "public" or "required"');
        value = auth;
      }
    }
    return value;
  }
  for (const m of modules.values()) {
    const ast = program.getSourceFile(m.path);
    if (!ast) throw new Error(`${relative(root, m.path)}: missing from the TypeScript program`);
    const symbol = checker.getSymbolAtLocation(ast);
    m.exports = symbol
      ? checker
          .getExportsOfModule(symbol)
          .filter((s) => {
            const target = s.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(s) : s;
            return !!(target.flags & ts.SymbolFlags.Value);
          })
          .map((s) => s.name)
      : [];
    if (m.directive === "use server") {
      for (const s of m.ast.statements) {
        if (ts.isExportDeclaration(s) && !s.isTypeOnly)
          fail(m, s, "Action reexports are unsupported; export named async declarations");
        if (
          ts.isImportDeclaration(s) ||
          ts.isInterfaceDeclaration(s) ||
          ts.isTypeAliasDeclaration(s) ||
          ts.isExpressionStatement(s)
        )
          continue;
        const exported =
          ts.canHaveModifiers(s) &&
          ts.getModifiers(s)?.some((x) => x.kind === ts.SyntaxKind.ExportKeyword);
        if (!exported) continue;
        if (
          ts.isVariableStatement(s) &&
          s.declarationList.declarations.every(
            (d) => ts.isIdentifier(d.name) && d.name.text === "auth",
          )
        ) {
          moduleAuth(m);
          continue;
        }
        if (
          !ts.isFunctionDeclaration(s) ||
          !s.name ||
          !s.modifiers?.some((x) => x.kind === ts.SyntaxKind.AsyncKeyword) ||
          s.modifiers?.some((x) => x.kind === ts.SyntaxKind.DefaultKeyword)
        )
          fail(m, s, '"use server" supports named exported async function declarations only');
        m.actionExports.push(s.name.text);
      }
    }
  }
  const clients = new Set<string>(),
    actions = new Set<string>(),
    serverGraph = new Set<string>(),
    clientGraph = new Set<string>();
  function serverVisit(p: string, from?: string) {
    if (serverGraph.has(p)) return;
    serverGraph.add(p);
    if (from) serverParent.set(p, from);
    const m = moduleAt(p);
    if (m.directive === "use client") {
      clients.add(p);
      return;
    }
    if (m.directive === "use server") actions.add(p);
    for (const i of m.imports) {
      const chain = via(graphChain(serverParent, p));
      if (i.name.startsWith("@opentui/"))
        fail(m, i.node, `OpenTUI native runtime is Client-only${chain}`);
      if (i.name === "client-only")
        fail(m, i.node, `Client-only module in Server graph: it never runs on the Server${chain}`);
      if (i.name === "react" && ts.isImportDeclaration(i.node)) {
        const bindings = i.node.importClause?.namedBindings;
        for (const element of bindings && ts.isNamedImports(bindings) ? bindings.elements : []) {
          const name = (element.propertyName ?? element.name).text;
          if (!element.isTypeOnly && clientOnlyReact.has(name))
            fail(
              m,
              element,
              `${name} is Client-only React: a Server Component cannot use it. Add "use client" at the top of this file, or move the part that needs it into a Client Component${chain}`,
            );
        }
      }
      if (i.path) serverVisit(i.path, p);
    }
  }
  function clientVisit(p: string, from?: string) {
    if (clientGraph.has(p)) return;
    clientGraph.add(p);
    if (from) clientParent.set(p, from);
    const m = moduleAt(p);
    if (m.directive === "use server") {
      actions.add(p);
      serverVisit(p);
      return;
    }
    const chain = () => via(clientChain(p));
    if (m.directive === "use cache" || m.cached.length)
      fail(m, m.ast, `"use cache" module in Client graph: it runs on the Server only${chain()}`);
    if (relative(root, p).split("/").includes("server"))
      fail(m, m.ast, `Server-only source in Client graph${chain()}`);
    for (const i of m.imports) {
      if (
        i.name === "server-only" ||
        i.name === "airtty/server" ||
        (i.path && relative(root, i.path).split("/").includes("server"))
      )
        fail(m, i.node, `Server-only import in Client graph: ${i.name}${chain()}`);
      if (!i.path && serverPackages.has(packageOf(i.name)))
        fail(
          m,
          i.node,
          `Server-only package in Client graph: ${i.name} (serverPackages in airtty.json)${chain()}`,
        );
      // Packages are bundled as they are; one reaching Server-only code fails below.
      if (i.path) clientVisit(i.path, p);
    }
  }
  for (const p of pages) serverVisit(p);
  if (hasAuth) serverVisit(authFile);
  if (hasCache) serverVisit(cacheFile);
  // Layouts persist across navigations; loading, error and not-found screens render
  // without a Server answer: all are Client Components owned by the TanStack route tree.
  for (const p of [...layouts, ...loadings]) {
    const m = moduleAt(p);
    const kind = basename(p);
    if (m.directive !== "use client" || !m.exports.includes("default"))
      fail(m, m.ast, `${kind} must declare "use client" and a default export`);
    clients.add(p);
  }
  for (const p of clients) clientVisit(p);
  // app/args.ts runs in the launcher, the app binary and the Server: plain code, no side.
  const argsGraph = new Set<string>();
  function argsVisit(p: string) {
    if (argsGraph.has(p)) return;
    argsGraph.add(p);
    const m = moduleAt(p);
    const chain = via([...argsGraph]);
    if (m.directive) fail(m, m.ast, `"${m.directive}" module in ${ARGS_FILE}'s graph${chain}`);
    if (relative(root, p).split("/").includes("server"))
      fail(m, m.ast, `Server-only source in ${ARGS_FILE}'s graph${chain}`);
    for (const i of m.imports) {
      if (
        ["server-only", "client-only", "airtty/server", "airtty/client"].includes(i.name) ||
        i.name.startsWith("@opentui/") ||
        (i.path && relative(root, i.path).split("/").includes("server"))
      )
        fail(
          m,
          i.node,
          `${ARGS_FILE} runs in the launcher and on the Server: it cannot import ${i.name}${chain}`,
        );
      if (i.path) argsVisit(i.path);
    }
  }
  if (hasArgs) argsVisit(argsFile);
  // Imports the bundler resolved, per role: rebuilds a package violation's chain.
  const edges: Record<"server" | "client", [importer: string, specifier: string][]> = {
    server: [],
    client: [],
  };
  const resolvesTo = (importer: string, specifier: string, target: string) => {
    try {
      return realpathSync(Bun.resolveSync(specifier, dirname(importer))) === target;
    } catch {
      return false;
    }
  };
  // From the application module that pulled it in, through packages, to `file`.
  const bundleChain = (role: "server" | "client", file: string) => {
    const chain = [file];
    let current = file;
    while (!modules.has(current) && chain.length < MAX_CHAIN) {
      const edge = edges[role].find(([importer, specifier]) =>
        resolvesTo(importer, specifier, current),
      );
      if (!edge || chain.includes(edge[0])) break;
      chain.unshift(edge[0]);
      current = edge[0];
    }
    if (!modules.has(current)) return chain;
    return [
      ...(role === "client" ? clientChain(current) : graphChain(serverParent, current)).slice(
        0,
        -1,
      ),
      ...chain,
    ];
  };
  // Every "use client" module is a Client Reference, even one only Client code imports:
  // it can be resolved by id like the boundaries the Server renders.
  for (const p of clientGraph) if (moduleAt(p).directive === "use client") clients.add(p);
  const hash = createHash("sha256");
  for (const m of [...modules.values()].sort((a, b) => a.path.localeCompare(b.path)))
    hash.update(relative(root, m.path)).update(m.text);
  // Every runtime source, so a new framework module can never be left out of the identity.
  for (const e of [...new Bun.Glob("**/*.{ts,tsx}").scanSync({ cwd: framework })].sort())
    hash.update(e).update(await readFile(join(framework, e)));
  // The packages of the framework and of the application (bundled into the Client) are
  // part of the build too: one lock when they share an installation (a workspace).
  const frameworkLock = governingLock(framework);
  if (!frameworkLock)
    throw new Error(
      `No bun.lock governs the airtty installation at ${framework}: install it with Bun`,
    );
  const appLock = governingLock(root);
  for (const lock of new Set([frameworkLock, appLock])) if (lock) hash.update(await readFile(lock));
  // What the build reads besides modules: the declaration (metadata, icon) and airtty.json.
  for (const file of [
    join(root, "package.json"),
    join(root, "airtty.json"),
    ...(declaration.iconFile ? [declaration.iconFile] : []),
  ])
    hash.update(relative(root, file)).update(await readFile(file).catch(() => Buffer.alloc(0)));
  let clientPackages: { name: string; version: string }[] = [];
  const buildId = hash.digest("hex").slice(0, BUILD_ID_LENGTH),
    id = (p: string) => `${buildId}/${relative(root, p)}`;
  const manifest: Record<string, unknown> = {};
  for (const p of clients)
    for (const name of moduleAt(p).exports)
      manifest[`${id(p)}#${name}`] = { id: id(p), chunks: [], name };
  const builtWith = { appBundle, webServer, signed: !!signBundle };
  // A signature is not part of the identity: a signed build is always made afresh.
  if (!signBundle && (await upToDate(output, buildId, builtWith))) return { buildId, output };
  const temp = `${output}-${crypto.randomUUID()}`;
  await mkdir(temp, { recursive: true });
  const routes = graph.pages.map((r, i) => ({
    ...r,
    name: `P${i}`,
    auth: moduleAuth(moduleAt(abs(r.file))),
  }));
  // Checked-in like TanStack's routeTree.gen.ts: application type checks need it
  // before any build. Rewritten only when the route graph changes.
  const routeTreeFile = abs(ROUTE_TREE_FILE),
    routeTreeSource = renderRouteTree(
      graph,
      new Map(
        graph.pages.flatMap((r) => {
          const m = moduleAt(abs(r.file));
          const ms = staleTimeOf(m.ast, (n, message) => fail(m, n, message));
          return ms === undefined ? [] : [[r.file, ms] as const];
        }),
      ),
    );
  if (
    (await Bun.file(routeTreeFile)
      .text()
      .catch(() => "")) !== routeTreeSource
  )
    await Bun.write(routeTreeFile, routeTreeSource);
  const serverSource =
    (hasArgs ? `import ${quote(join(framework, "args-server.ts"))};` : "") +
    `import {serve} from ${quote(join(framework, "server.ts"))};${hasAuth ? `import Auth from ${quote(authFile)};` : ""}${hasCache ? `import Cache from ${quote(cacheFile)};` : ""}\n` +
    // The Server parses its launch's arguments before anything reads them.
    (hasArgs
      ? `import {configureArgs} from ${quote(join(framework, "args.ts"))};import Args from ${quote(argsFile)};await configureArgs(Args,process.env,process.cwd());\n`
      : "") +
    routes.map((r) => `import ${r.name} from ${quote(abs(r.file))};`).join("\n") +
    "\n" +
    [...actions].map((p, i) => `import * as A${i} from ${quote(p)};`).join("\n") +
    `\nconst actions=new Map([${[...actions].flatMap((p, i) => moduleAt(p).actionExports.map((n) => `[${quote(id(p) + "#" + n)},{fn:A${i}[${quote(n)}],auth:${quote(moduleAuth(moduleAt(p)))}}]`)).join(",")}]);\n` +
    `serve({buildId:${quote(buildId)},manifest:${quote(manifest)},actions,routes:new Map([${routes.map((r) => `[${quote(r.id)},{component:${r.name},auth:${quote(r.auth)},url:${quote(r.url)},params:${quote(r.params)}}]`).join(",")}])${hasAuth ? ",auth:Auth" : ""}${hasCache ? ",cache:Cache" : ""},appBundle:import.meta.dir+"/../app",web:import.meta.dir+"/../web"});`;
  const clientSource =
    `export {Shell,run} from ${quote(join(framework, "client.tsx"))};import {createApplication,run} from ${quote(join(framework, "client.tsx"))};import {routeTree} from ${quote(routeTreeFile)};import {actions} from "airtty:actions";\n` +
    [...clients].map((p, i) => `import * as C${i} from ${quote(p)};`).join("\n") +
    `\nconst modules=new Map([${[...clients].map((p, i) => `[${quote(id(p))},C${i}]`).join(",")}]);export function createApp(options){const app=createApplication({...options,routeTree,buildId:${quote(buildId)},title:${quote(basename(root).toUpperCase())},resolveModule:id=>{if(!modules.has(id))throw new Error('Unknown module '+id);return modules.get(id)}});actions.bind(app);return app};if(import.meta.main)await run(createApp,{name:${quote(basename(root))}});`;
  // The application bundle: what the Client source has, minus the runtime, which the host
  // that evaluates it provides through the ABI (src/abi.ts, src/app-evaluate.ts).
  const appSource =
    `export {routeTree} from ${quote(routeTreeFile)};import {actions} from "airtty:actions";export {actions};\n` +
    [...clients].map((p, i) => `import * as C${i} from ${quote(p)};`).join("\n") +
    `\nexport const buildId=${quote(buildId)};export const modules={${[...clients].map((p, i) => `${quote(id(p))}:C${i}`).join(",")}};`;
  let appBuiltins: string[] = [];
  let args: AppArgs | undefined;
  let appSkipped = false;
  const external = [
    "react",
    "react-dom",
    "react-server-dom-webpack",
    "@opentui/core",
    "@opentui/react",
    "react-reconciler",
  ];
  try {
    type Role = "server" | "client" | "app" | "web-server" | "args";
    const roles: readonly Role[] = [
      "server",
      "client",
      "app",
      ...(webServer ? ["web-server" as const] : []),
      ...(hasArgs ? ["args" as const] : []),
    ];
    for (const role of roles) {
      // The application bundle is Client code: same boundaries, same stubs. The browser's
      // Server is the Server: same stubs, references and cache, another platform.
      const serverSide = role === "server" || role === "web-server";
      const clientSide = !serverSide;
      const browserServer = role === "web-server";
      const entry = join(temp, `${role}-entry.ts`);
      await Bun.write(
        entry,
        browserServer
          ? `import ${quote(WEB_SERVER_SETUP)};\n${serverSource}`
          : role === "server"
            ? serverSource
            : role === "client"
              ? clientSource
              : role === "args"
                ? `export {default} from ${quote(argsFile)};`
                : appSource,
      );
      const result = await Bun.build({
        entrypoints: [entry],
        outdir: join(temp, role),
        naming: role === "app" ? "index.cjs" : browserServer ? WEB_SERVER_FILE : "index.js",
        target: browserServer ? "browser" : "bun",
        // bun-cjs: a function of (exports, require, module…) the host calls with the ABI.
        ...(role === "app" ? { format: "cjs" as const } : {}),
        // The arguments module is whole: a launcher imports it from anywhere.
        external: role === "app" || role === "args" || browserServer ? [] : external,
        conditions: serverSide ? ["react-server"] : [],
        // A browser bundle carries no environment: React's production builds, as the page's.
        ...(browserServer
          ? { minify: true, define: { "process.env.NODE_ENV": JSON.stringify("production") } }
          : {}),
        metafile: clientSide,
        // Next to the bundle, and linked from it: Bun maps runtime stack traces through it
        // (development and production alike) and a debugger finds it. Inline would double
        // the bundle a compiled Client embeds; external would be found by nothing.
        sourcemap: "linked",
        // The production JSX runtime, as `transpileModule` emitted: React's production
        // build has no `jsxDEV`. Each file's pragma picks the import source.
        jsx: { runtime: "automatic", development: false },
        plugins: [
          ...(browserServer ? webServerPlugins : []),
          {
            name: "airtty-boundaries",
            setup(b) {
              // Every import, recorded for chains. A package made for the other side never
              // reaches this bundle: `server-only`, `airtty/server` or a listed Server
              // package in the Client; `client-only` in the Server. Application code was
              // already checked, with file and line, on the module graphs.
              b.onResolve({ filter: /.*/ }, (a) => {
                if (!a.importer) return undefined;
                if (!browserServer)
                  edges[clientSide ? "client" : "server"].push([a.importer, a.path]);
                const owner = packageOfFile(a.importer);
                if (!owner || a.path.startsWith(".")) return undefined;
                const why = clientSide
                  ? a.path === "server-only" || a.path === "airtty/server"
                    ? "it is Server-only"
                    : serverPackages.has(packageOf(a.path))
                      ? "it is listed in serverPackages (airtty.json)"
                      : undefined
                  : a.path === "client-only"
                    ? "it never runs on the Server"
                    : undefined;
                if (why)
                  throw new Error(
                    `${clientSide ? "Client" : "Server"} package ${owner.name} imports ${a.path}: ${why}` +
                      `${via(bundleChain(clientSide ? "client" : "server", a.importer))} → ${a.path}`,
                  );
                return undefined;
              });
              // Application code sees `airtty/client` with this bundle's own `host`, bound
              // like its Server Functions (airtty:actions): the runtime's is bound to none.
              if (clientSide) {
                // Its own import, and airtty:actions', fall through to the real module.
                b.onResolve({ filter: /^airtty\/client$/ }, (a) =>
                  a.importer.startsWith("airtty:")
                    ? undefined
                    : { path: "airtty:client", namespace: "airtty-client" },
                );
                b.onLoad({ filter: /.*/, namespace: "airtty-client" }, () => ({
                  contents: `export * from "airtty/client";import {actions} from "airtty:actions";export const host=actions.host;`,
                  loader: "js",
                }));
              }
              // The runtime ABI stays outside the application bundle: the host provides it.
              if (role === "app")
                b.onResolve({ filter: /^[@a-z]/ }, (a) =>
                  isAbiSpecifier(a.path) ? { path: a.path, external: true } : undefined,
                );
              b.onResolve({ filter: /^airtty\/(client|server|route-tree|args|grammars)$/ }, (a) => {
                const entry = FRAMEWORK_ENTRIES.get(a.path.slice("airtty/".length));
                if (!entry) throw new Error(`Unknown framework entry ${a.path}`);
                return { path: join(framework, entry) };
              });
              // Bun's "bun" export condition selects TanStack's server build, which skips
              // the Client transition machinery; the terminal Client is a browser-like runtime.
              if (role === "client") {
                b.onResolve({ filter: /^@tanstack\/router-core\/isServer$/ }, () => ({
                  path: tanstackClientBuild,
                }));
                // One router instance: application sources, including the generated
                // route tree, share the framework's copy.
                b.onResolve({ filter: /^@tanstack\/react-router$/ }, () => ({
                  path: Bun.resolveSync("@tanstack/react-router", framework),
                }));
              }
              // One zod instance, the pinned one: application schemas share the framework's
              // copy, installed or not, like the router above. A package keeps the zod it
              // depends on, whatever its major version.
              b.onResolve({ filter: /^zod(\/.*)?$/ }, (a) =>
                packageOfFile(a.importer)
                  ? undefined
                  : { path: Bun.resolveSync(a.path, framework) },
              );
              // Native code cannot be bundled: resolved at run time, from node_modules or
              // from an app binary's native/ (src/native.ts, src/compile.ts).
              if (role === "server")
                b.onResolve({ filter: /^[^./]/ }, (a) =>
                  a.importer && nativePackage(a.path, a.importer)
                    ? { path: a.path, external: true }
                    : undefined,
                );
              // One binding of imported Server Functions per bundle: createApp gives it the
              // Application it creates (src/client.tsx, createActions); in an application
              // bundle, the host's openApplication does.
              if (clientSide) {
                b.onResolve({ filter: /^airtty:actions$/ }, (a) => ({
                  path: a.path,
                  namespace: "airtty-actions",
                }));
                b.onLoad({ filter: /.*/, namespace: "airtty-actions" }, () => ({
                  contents: `import {createActions} from ${quote(role === "app" ? "airtty/client" : join(framework, "client.tsx"))};export const actions=createActions();`,
                  loader: "js",
                }));
              }
              // Side markers carry no code of their own.
              b.onResolve({ filter: /^(server-only|client-only)$/ }, (a) => ({
                path: a.path,
                namespace: "marker",
              }));
              b.onLoad({ filter: /.*/, namespace: "marker" }, () => ({
                contents: "",
                loader: "js",
              }));
              b.onLoad({ filter: /\.[tj]sx?$/ }, async (a) => {
                const m = modules.get(a.path);
                let source = m?.text ?? (await readFile(a.path, "utf8"));
                if (serverSide && m?.directive === "use client")
                  source =
                    `import {registerClientReference as ref} from ${quote(join(framework, "flight/server.ts"))};\n` +
                    m.exports
                      .map(
                        (n, i) =>
                          `const c${i}=ref(()=>{throw new Error('Cannot invoke Client export on Server')},${quote(id(m.path))},${quote(n)});export {c${i} as ${n}};`,
                      )
                      .join("\n");
                else if (clientSide && m?.directive === "use server")
                  source =
                    `import {actions} from "airtty:actions";\n` +
                    m.actionExports
                      .map(
                        (n) =>
                          `export const ${n}=actions.reference(${quote(id(m.path) + "#" + n)});`,
                      )
                      .join("\n");
                else if (serverSide && m?.directive === "use server")
                  source +=
                    `\nimport {registerServerReference as register} from ${quote(join(framework, "flight/server.ts"))};\n` +
                    m.actionExports
                      .map((n) => `register(${n},${quote(id(m.path))},${quote(n)});`)
                      .join("\n");
                if (serverSide && m?.cached.length)
                  source += cacheSource(
                    m.cached,
                    (n) => `${relative(root, m.path)}#${n}`,
                    join(framework, "cache/runtime.ts"),
                  );
                // Original names, sources and hook bindings for the DevTools; the framework
                // too, not what packages ship.
                if (!a.path.includes("/node_modules/"))
                  source = annotateNames(source, {
                    path: a.path,
                    relative: relative(root, a.path),
                    runtime: join(framework, "devtools/annotate.ts"),
                  });
                // Without async context in a Worker, every wait carries its store (W6).
                if (browserServer) source = transformAsyncContext(source, a.path);
                const jsxImportSource = serverSide ? "react" : "@opentui/react";
                // TypeScript is Bun's to strip, so the source map points at the original
                // lines (Bun does not compose a plugin's own map). The pragma shares the
                // first line: no line moves. Application code is erasable syntax only.
                if (/\.tsx?$/.test(a.path))
                  return {
                    contents: `/** @jsxImportSource ${jsxImportSource} */ ${source}`,
                    loader: a.path.endsWith("x") ? "tsx" : "ts",
                  };
                return {
                  contents: ts.transpileModule(source, {
                    fileName: a.path,
                    compilerOptions: {
                      target: ts.ScriptTarget.ESNext,
                      module: ts.ModuleKind.ESNext,
                      jsx: ts.JsxEmit.ReactJSX,
                      jsxImportSource,
                    },
                  }).outputText,
                  loader: "js",
                };
              });
            },
          },
        ],
      }).catch((error: unknown) => {
        const at = role === "app" ? topLevelAwait(root, error) : undefined;
        if (!at) return bundleFailure(error);
        const why =
          `${at}: top-level await in Client code: the application bundle (.airtty/app) is ` +
          "CommonJS and cannot express it, so this application cannot be embedded. " +
          "Await inside a function (an effect, a loader) to make it embeddable.";
        if (appBundle === "required") throw new Error(why);
        // The Client and the Server are built as before: only embedding is lost.
        console.warn(`airtty build: ${basename(root)}: ${why}`);
        return undefined;
      });
      if (!result) {
        appSkipped = true;
        await rm(join(temp, role), { recursive: true, force: true });
        await rm(entry);
        continue;
      }
      if (!result.success) throw new Error(logMessages(result.logs));
      if (role === "app") {
        // What the bundle requires beyond the ABI, as its `require` calls name them: Node
        // built-ins, which Bun externalizes before any plugin runs, read from the metafile.
        const required = new Set<string>();
        for (const input of Object.values(result.metafile?.inputs ?? {}))
          for (const i of input.imports)
            if (i.external && !isAbiSpecifier(i.path)) required.add(i.path);
        appBuiltins = [...required].sort();
        await rm(entry);
        continue;
      }
      // Inventory of what the Client really embeds, read from the bundler itself.
      if (role === "client" && result.metafile) {
        const found = new Map<string, string>();
        for (const input of Object.keys(result.metafile.inputs)) {
          const owner = packageOfFile(resolve(input));
          if (owner && !found.has(owner.name))
            found.set(
              owner.name,
              (await readJsonFile(join(owner.dir, "package.json"), InstalledPackage)).version,
            );
        }
        clientPackages = [...found]
          .sort(([a], [b]) => (a < b ? -1 : 1))
          .map(([name, version]) => ({ name, version }));
      }
      if (browserServer) copyWebServerFiles(join(temp, role));
      if (role === "args") args = await readArgs(join(temp, role, "index.js"), root);
      await rm(entry);
    }
    await Bun.write(
      join(temp, "manifest.json"),
      JSON.stringify(
        {
          buildId,
          options: builtWith,
          manifest,
          routes: routes.map((r) => ({
            id: r.id,
            url: r.url,
            auth: r.auth,
            page: r.file,
            layouts: r.layouts,
            loading: r.loading ?? null,
            error: r.error ?? null,
            notFound: r.notFound ?? null,
          })),
          clientPackages,
          serverGraph: [...serverGraph].map((p) => relative(root, p)),
          clientGraph: [...clientGraph].map((p) => relative(root, p)),
        },
        null,
        2,
      ),
    );
    if (!appSkipped)
      await writeAppManifest(root, join(temp, "app"), {
        buildId,
        builtins: appBuiltins,
        capabilities: declaration.capabilities,
        publisher: signBundle,
      });
    await writeAppMetadata(temp, { ...declaration, metadata: { ...declaration.metadata, args } });
    // Failed builds never touch the active artefacts.
    const backup = output + "-previous";
    await rm(backup, { recursive: true, force: true });
    if (await Bun.file(join(output, "manifest.json")).exists()) await rename(output, backup);
    await rename(temp, output);
    await rm(backup, { recursive: true, force: true });
    return { buildId, output };
  } catch (error) {
    await rm(temp, { recursive: true, force: true });
    throw error;
  }
}
