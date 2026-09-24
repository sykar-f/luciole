import ts from "@typescript/typescript6";
import { basename, resolve, relative, dirname, join } from "node:path";
import { mkdir, readFile, readdir, rename, rm, realpath } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { createHash } from "node:crypto";
import { z } from "zod";
import { bundleMessages, logMessages } from "./bundle-errors";
import { readJsonFile, readPackageJson } from "./package-json";
import { ROUTE_TREE_FILE, compileRouteGraph, renderRouteTree } from "./route-graph";
import { cachedFunctions, cacheSource, staleTimeOf } from "./cache/transform";
import { annotateNames } from "./build-names";
const framework = dirname(import.meta.path);
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
function bundleFailure(error: unknown): never {
  throw new Error(bundleMessages(error).join("\n"));
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
]);
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
export async function build(directory: string, output = join(directory, ".airtty")) {
  const root = await realpath(directory),
    modules = new Map<string, Module>();
  const { serverPackages } = await readConfig(root);
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
    const p = m.ast.getLineAndCharacterOfPosition(n.getStart(m.ast));
    throw new Error(`${relative(root, m.path)}:${p.line + 1}:${p.character + 1}: ${message}`);
  }
  const moduleAt = (path: string) => {
    const m = modules.get(path);
    if (!m) throw new Error(`Module read without its source: ${path}`);
    return m;
  };
  async function local(from: string, name: string) {
    if (!name.startsWith(".")) return;
    const base = resolve(dirname(from), name);
    for (const candidate of [
      base,
      ...[".ts", ".tsx", ".js", ".jsx", "/index.ts", "/index.tsx"].map((s) => base + s),
    ]) {
      if (await Bun.file(candidate).exists()) return await realpath(candidate);
    }
    throw new Error(`${from}: Cannot resolve ${name}`);
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
    if (error) fail(m, ast, ts.flattenDiagnosticMessageText(error.messageText, " "));
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
    for (const i of m.imports) {
      i.path = await local(path, i.name);
      if (i.path) await read(i.path);
    }
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
  for (const p of [
    ...pages,
    ...layouts,
    ...loadings,
    ...(hasAuth ? [authFile] : []),
    ...(hasCache ? [cacheFile] : []),
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
  hash.update(await readFile(join(framework, "../bun.lock")));
  // The application's packages (bundled into the Client) are part of the build too.
  const appLock = Bun.file(join(root, "bun.lock"));
  if (await appLock.exists()) hash.update(await appLock.text());
  let clientPackages: { name: string; version: string }[] = [];
  const buildId = hash.digest("hex").slice(0, BUILD_ID_LENGTH),
    id = (p: string) => `${buildId}/${relative(root, p)}`;
  const manifest: Record<string, unknown> = {};
  for (const p of clients)
    for (const name of moduleAt(p).exports)
      manifest[`${id(p)}#${name}`] = { id: id(p), chunks: [], name };
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
    `import {serve} from ${quote(join(framework, "server.ts"))};${hasAuth ? `import Auth from ${quote(authFile)};` : ""}${hasCache ? `import Cache from ${quote(cacheFile)};` : ""}\n` +
    routes.map((r) => `import ${r.name} from ${quote(abs(r.file))};`).join("\n") +
    "\n" +
    [...actions].map((p, i) => `import * as A${i} from ${quote(p)};`).join("\n") +
    `\nconst actions=new Map([${[...actions].flatMap((p, i) => moduleAt(p).actionExports.map((n) => `[${quote(id(p) + "#" + n)},{fn:A${i}[${quote(n)}],auth:${quote(moduleAuth(moduleAt(p)))}}]`)).join(",")}]);\n` +
    `serve({buildId:${quote(buildId)},manifest:${quote(manifest)},actions,routes:new Map([${routes.map((r) => `[${quote(r.id)},{component:${r.name},auth:${quote(r.auth)},url:${quote(r.url)},params:${quote(r.params)}}]`).join(",")}])${hasAuth ? ",auth:Auth" : ""}${hasCache ? ",cache:Cache" : ""}});`;
  const clientSource =
    `export {Shell,run} from ${quote(join(framework, "client.tsx"))};import {createApplication,run} from ${quote(join(framework, "client.tsx"))};import {routeTree} from ${quote(routeTreeFile)};\n` +
    [...clients].map((p, i) => `import * as C${i} from ${quote(p)};`).join("\n") +
    `\nconst modules=new Map([${[...clients].map((p, i) => `[${quote(id(p))},C${i}]`).join(",")}]);export function createApp(options){return createApplication({...options,routeTree,buildId:${quote(buildId)},title:${quote(basename(root).toUpperCase())},resolveModule:id=>{if(!modules.has(id))throw new Error('Unknown module '+id);return modules.get(id)}})};if(import.meta.main)await run(createApp,{name:${quote(basename(root))}});`;
  const external = [
    "react",
    "react-dom",
    "react-server-dom-webpack",
    "@opentui/core",
    "@opentui/react",
    "react-reconciler",
  ];
  try {
    for (const role of ["server", "client"] as const) {
      const entry = join(temp, `${role}-entry.ts`);
      await Bun.write(entry, role === "server" ? serverSource : clientSource);
      const result = await Bun.build({
        entrypoints: [entry],
        outdir: join(temp, role),
        naming: "index.js",
        target: "bun",
        external,
        conditions: role === "server" ? ["react-server"] : [],
        metafile: role === "client",
        // Next to the bundle, and linked from it: Bun maps runtime stack traces through it
        // (development and production alike) and a debugger finds it. Inline would double
        // the bundle a compiled Client embeds; external would be found by nothing.
        sourcemap: "linked",
        // The production JSX runtime, as `transpileModule` emitted: React's production
        // build has no `jsxDEV`. Each file's pragma picks the import source.
        jsx: { runtime: "automatic", development: false },
        plugins: [
          {
            name: "airtty-boundaries",
            setup(b) {
              // Every import, recorded for chains. A package made for the other side never
              // reaches this bundle: `server-only`, `airtty/server` or a listed Server
              // package in the Client; `client-only` in the Server. Application code was
              // already checked, with file and line, on the module graphs.
              b.onResolve({ filter: /.*/ }, (a) => {
                if (!a.importer) return undefined;
                edges[role].push([a.importer, a.path]);
                const owner = packageOfFile(a.importer);
                if (!owner || a.path.startsWith(".")) return undefined;
                const why =
                  role === "client"
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
                    `${role === "client" ? "Client" : "Server"} package ${owner.name} imports ${a.path}: ${why}` +
                      `${via(bundleChain(role, a.importer))} → ${a.path}`,
                  );
                return undefined;
              });
              b.onResolve({ filter: /^airtty\/(client|server|route-tree)$/ }, (a) => {
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
                if (role === "server" && m?.directive === "use client")
                  source =
                    `import {registerClientReference as ref} from ${quote(join(framework, "flight/server.ts"))};\n` +
                    m.exports
                      .map(
                        (n, i) =>
                          `const c${i}=ref(()=>{throw new Error('Cannot invoke Client export on Server')},${quote(id(m.path))},${quote(n)});export {c${i} as ${n}};`,
                      )
                      .join("\n");
                else if (role === "client" && m?.directive === "use server")
                  source =
                    `import {actionReference} from ${quote(join(framework, "client.tsx"))};\n` +
                    m.actionExports
                      .map(
                        (n) => `export const ${n}=actionReference(${quote(id(m.path) + "#" + n)});`,
                      )
                      .join("\n");
                else if (role === "server" && m?.directive === "use server")
                  source +=
                    `\nimport {registerServerReference as register} from ${quote(join(framework, "flight/server.ts"))};\n` +
                    m.actionExports
                      .map((n) => `register(${n},${quote(id(m.path))},${quote(n)});`)
                      .join("\n");
                if (role === "server" && m?.cached.length)
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
                const jsxImportSource = role === "server" ? "react" : "@opentui/react";
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
      }).catch(bundleFailure);
      if (!result.success) throw new Error(logMessages(result.logs));
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
      const pkg = await readPackageJson(join(framework, "../package.json"));
      await Bun.write(
        join(temp, role, "package.json"),
        JSON.stringify(
          {
            name: pkg.name,
            private: true,
            type: "module",
            dependencies: pkg.dependencies,
            devDependencies: pkg.devDependencies,
            overrides: pkg.overrides,
          },
          null,
          2,
        ),
      );
      await Bun.write(join(temp, role, "bun.lock"), await readFile(join(framework, "../bun.lock")));
      await rm(entry);
    }
    await Bun.write(
      join(temp, "manifest.json"),
      JSON.stringify(
        {
          buildId,
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
