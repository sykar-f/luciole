import ts from "@typescript/typescript6";
import { basename, resolve, relative, dirname, join } from "node:path";
import { mkdir, readFile, readdir, rename, rm, realpath } from "node:fs/promises";
import { createHash } from "node:crypto";
import { ROUTE_TREE_FILE, compileRouteGraph, renderRouteTree } from "./route-graph";
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
};
type RouteAuth = "public" | "required";
export async function build(directory: string, output = join(directory, ".terminal")) {
  const root = await realpath(directory),
    modules = new Map<string, Module>();
  const fail = (m: Module, n: ts.Node, message: string): never => {
    const p = m.ast.getLineAndCharacterOfPosition(n.getStart(m.ast));
    throw new Error(`${relative(root, m.path)}:${p.line + 1}:${p.character + 1}: ${message}`);
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
    };
    modules.set(path, m);
    const errors = (ast as any).parseDiagnostics as ts.Diagnostic[];
    if (errors.length) fail(m, ast, ts.flattenDiagnosticMessageText(errors[0].messageText, " "));
    for (const s of ast.statements) {
      if (ts.isExpressionStatement(s) && ts.isStringLiteral(s.expression)) {
        if (s.expression.text === "use client" || s.expression.text === "use server") {
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
      else if (["page.tsx", "layout.tsx", "loading.tsx"].includes(e.name))
        inventory.push(relative(root, p));
    }
  }
  await walk(join(root, "app"));
  const graph = compileRouteGraph(inventory);
  const abs = (p: string) => join(root, p);
  const pages = graph.pages.map((r) => abs(r.file));
  const layouts = [graph.root, ...graph.layouts.map((l) => l.file)].map(abs);
  const loadings = [...new Set(graph.pages.flatMap((r) => (r.loading ? [r.loading] : [])))].map(
    abs,
  );
  const authFile = join(root, "server/auth.ts");
  const hasAuth = await Bun.file(authFile).exists();
  for (const p of [...pages, ...layouts, ...loadings, ...(hasAuth ? [authFile] : [])])
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
        if (
          !initializer ||
          !ts.isStringLiteral(initializer) ||
          !["public", "required"].includes(initializer.text)
        )
          fail(m, declaration, 'auth must be the literal "public" or "required"');
        value = (initializer as ts.StringLiteral).text as RouteAuth;
      }
    }
    return value;
  }
  for (const m of modules.values()) {
    const ast = program.getSourceFile(m.path)!;
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
        m.actionExports.push((s as ts.FunctionDeclaration).name!.text);
      }
    }
  }
  const clients = new Set<string>(),
    actions = new Set<string>(),
    serverGraph = new Set<string>(),
    clientGraph = new Set<string>();
  function serverVisit(p: string) {
    if (serverGraph.has(p)) return;
    serverGraph.add(p);
    const m = modules.get(p)!;
    if (m.directive === "use client") {
      clients.add(p);
      return;
    }
    if (m.directive === "use server") actions.add(p);
    for (const i of m.imports) {
      if (i.name.startsWith("@opentui/")) fail(m, i.node, "OpenTUI native runtime is Client-only");
      if (i.path) serverVisit(i.path);
    }
  }
  function clientVisit(p: string) {
    if (clientGraph.has(p)) return;
    clientGraph.add(p);
    const m = modules.get(p)!;
    if (m.directive === "use server") {
      actions.add(p);
      serverVisit(p);
      return;
    }
    if (relative(root, p).split("/").includes("server"))
      fail(m, m.ast, "Server-only source in Client graph");
    for (const i of m.imports) {
      if (
        i.name === "server-only" ||
        i.name === "@terminal/framework/server" ||
        /^(node:|bun:)/.test(i.name) ||
        (i.path && relative(root, i.path).split("/").includes("server"))
      )
        fail(m, i.node, `Server-only import in Client graph: ${i.name}`);
      if (i.path) clientVisit(i.path);
      else if (
        !["react", "react/jsx-runtime", "@terminal/framework/client"].includes(i.name) &&
        !i.name.startsWith("@opentui/")
      )
        fail(
          m,
          i.node,
          `Unanalysed package in Client graph: ${i.name}; use local source modules or add an audited compiler integration`,
        );
    }
  }
  for (const p of pages) serverVisit(p);
  if (hasAuth) serverVisit(authFile);
  // Layouts persist across navigations and loadings render before any Server answer:
  // both are Client Components owned by the TanStack route tree.
  for (const p of [...layouts, ...loadings]) {
    const m = modules.get(p)!;
    const kind = p.endsWith("layout.tsx") ? "layout.tsx" : "loading.tsx";
    if (m.directive !== "use client" || !m.exports.includes("default"))
      fail(m, m.ast, `${kind} must declare "use client" and a default export`);
    clients.add(p);
  }
  for (const p of clients) clientVisit(p);
  const hash = createHash("sha256");
  for (const m of [...modules.values()].sort((a, b) => a.path.localeCompare(b.path)))
    hash.update(relative(root, m.path)).update(m.text);
  for (const e of [
    "build.ts",
    "client.tsx",
    "server.ts",
    "draft.ts",
    "route-graph.ts",
    "route-tree.tsx",
    "transport.ts",
    "flight/client.ts",
    "flight/server.ts",
  ])
    hash.update(await readFile(join(framework, e)));
  hash.update(await readFile(join(framework, "../bun.lock")));
  const buildId = hash.digest("hex").slice(0, 24),
    id = (p: string) => `${buildId}/${relative(root, p)}`;
  const manifest: Record<string, unknown> = {};
  for (const p of clients)
    for (const name of modules.get(p)!.exports)
      manifest[`${id(p)}#${name}`] = { id: id(p), chunks: [], name };
  const temp = `${output}-${crypto.randomUUID()}`;
  await mkdir(temp, { recursive: true });
  const routes = graph.pages.map((r, i) => ({
    ...r,
    name: `P${i}`,
    auth: moduleAuth(modules.get(abs(r.file))!),
  }));
  // Checked-in like TanStack's routeTree.gen.ts: application type checks need it
  // before any build. Rewritten only when the route graph changes.
  const routeTreeFile = abs(ROUTE_TREE_FILE),
    routeTreeSource = renderRouteTree(graph);
  if (
    (await Bun.file(routeTreeFile)
      .text()
      .catch(() => "")) !== routeTreeSource
  )
    await Bun.write(routeTreeFile, routeTreeSource);
  const serverSource =
    `import {serve} from ${quote(join(framework, "server.ts"))};${hasAuth ? `import Auth from ${quote(authFile)};` : ""}\n` +
    routes.map((r) => `import ${r.name} from ${quote(abs(r.file))};`).join("\n") +
    "\n" +
    [...actions].map((p, i) => `import * as A${i} from ${quote(p)};`).join("\n") +
    `\nconst actions=new Map([${[...actions].flatMap((p, i) => modules.get(p)!.actionExports.map((n) => `[${quote(id(p) + "#" + n)},{fn:A${i}[${quote(n)}],auth:${quote(moduleAuth(modules.get(p)!))}}]`)).join(",")}]);\n` +
    `serve({buildId:${quote(buildId)},manifest:${quote(manifest)},actions,routes:new Map([${routes.map((r) => `[${quote(r.id)},{component:${r.name},auth:${quote(r.auth)},url:${quote(r.url)},params:${quote(r.params)}}]`).join(",")}])${hasAuth ? ",auth:Auth" : ""}});`;
  const clientSource =
    `export {Shell} from ${quote(join(framework, "client.tsx"))};import {createApplication,run} from ${quote(join(framework, "client.tsx"))};import {routeTree} from ${quote(routeTreeFile)};\n` +
    [...clients].map((p, i) => `import * as C${i} from ${quote(p)};`).join("\n") +
    `\nconst modules=new Map([${[...clients].map((p, i) => `[${quote(id(p))},C${i}]`).join(",")}]);export function createApp(options){return createApplication({...options,routeTree,buildId:${quote(buildId)},title:${quote(basename(root).toUpperCase())},resolveModule:id=>{if(!modules.has(id))throw new Error('Unknown module '+id);return modules.get(id)}})};if(import.meta.main)await run(createApp);`;
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
        plugins: [
          {
            name: "terminal-boundaries",
            setup(b) {
              b.onResolve(
                { filter: /^@terminal\/framework\/(client|server|route-tree)$/ },
                (a) => ({
                  path: join(
                    framework,
                    { client: "client.tsx", server: "server.ts", "route-tree": "route-tree.tsx" }[
                      a.path.slice("@terminal/framework/".length)
                    ]!,
                  ),
                }),
              );
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
              b.onResolve({ filter: /^server-only$/ }, () => ({
                path: "server-only",
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
                return {
                  contents: ts.transpileModule(source, {
                    fileName: a.path,
                    compilerOptions: {
                      target: ts.ScriptTarget.ESNext,
                      module: ts.ModuleKind.ESNext,
                      jsx: ts.JsxEmit.ReactJSX,
                      jsxImportSource: role === "server" ? "react" : "@opentui/react",
                    },
                  }).outputText,
                  loader: "js",
                };
              });
            },
          },
        ],
      });
      if (!result.success) throw new Error(result.logs.join("\n"));
      const pkg = JSON.parse(await readFile(join(framework, "../package.json"), "utf8"));
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
          })),
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
