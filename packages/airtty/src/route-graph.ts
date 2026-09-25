/**
 * Compiles the `app/` file inventory into the route graph shared by the Client
 * route tree and the Server registry. Pure and deterministic: callers pass
 * root-relative POSIX paths and receive diagnostics as thrown errors.
 */
import { messageOf } from "./guards";

export const ROOT_ID = "__root__";

export type LayoutNode = {
  /** Physical source directory below `app/`, groups included. */
  id: string;
  parent: string;
  /** TanStack path relative to the parent; `undefined` for a pathless layout. */
  path: string | undefined;
  file: string;
};

export type PageNode = {
  /** Server routeId: `/` plus the physical source directory, groups included. */
  id: string;
  parent: string;
  /** TanStack path relative to the parent layout; `/` is its index route. */
  path: string;
  /** Full URL pattern, groups removed, parameters as `$name`. */
  url: string;
  params: string[];
  file: string;
  loading: string | undefined;
  /** Nearest `error.tsx` and `not-found.tsx`, inherited like `loading.tsx`. */
  error?: string;
  notFound?: string;
  /** Name of the trailing catch-all parameter (`[...name]`), matching one or more segments. */
  splat?: string;
  /** Layout files from `app/layout.tsx` to the nearest one. */
  layouts: string[];
};

export type RouteGraph = {
  root: string;
  /** `app/not-found.tsx`: shown for a URL no page matches. */
  notFound?: string;
  layouts: LayoutNode[];
  pages: PageNode[];
};

type Segment = { kind: "static" | "param" | "splat" | "group"; name: string };
const KINDS = ["page", "layout", "loading", "error", "not-found"] as const;
type Kind = (typeof KINDS)[number];
const SPLAT_OPEN = "[...";

function parseSegment(raw: string): Segment {
  if (/^\([^()[\]$/]+\)$/.test(raw)) return { kind: "group", name: raw };
  if (/^\[[A-Za-z_][\w]*\]$/.test(raw)) return { kind: "param", name: raw.slice(1, -1) };
  if (/^\[\.\.\.[A-Za-z_][\w]*\]$/.test(raw))
    return { kind: "splat", name: raw.slice(SPLAT_OPEN.length, -1) };
  if (raw && !/[()[\]$]/.test(raw)) return { kind: "static", name: raw };
  throw new Error(`Malformed route segment "${raw}"`);
}

const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

export function compileRouteGraph(files: readonly string[]): RouteGraph {
  const dirs = new Map<string, Partial<Record<Kind, string>>>();
  for (const file of [...files].sort(compare)) {
    const match = /^app((?:\/[^/]+)*)\/(page|layout|loading|error|not-found)\.tsx$/.exec(file);
    if (!match) continue;
    const dir = match[1].slice(1);
    const kind = KINDS.find((k) => k === match[2]);
    if (!kind) continue;
    const entry = dirs.get(dir) ?? {};
    entry[kind] = file;
    dirs.set(dir, entry);
  }
  const root = dirs.get("")?.layout;
  if (!root) throw new Error("app/layout.tsx required");
  if (![...dirs.values()].some((d) => d.page)) throw new Error("No app/**/page.tsx routes");

  const segments = (dir: string) => {
    const parts = dir ? dir.split("/") : [];
    const parsed = parts.map((raw) => {
      try {
        return parseSegment(raw);
      } catch (error) {
        throw new Error(`app/${dir}: ${messageOf(error)}`);
      }
    });
    if (parsed.slice(0, -1).some((s) => s.kind === "splat"))
      throw new Error(`app/${dir}: A catch-all segment must be the last one`);
    return parsed;
  };
  const urlParts = (dir: string) =>
    segments(dir)
      .filter((s) => s.kind !== "group")
      .map((s) => (s.kind === "param" ? `$${s.name}` : s.kind === "splat" ? "$" : s.name));
  // Nearest directory at or above `dir` holding `kind`; "" is `app/` itself.
  const ancestors = (dir: string) => {
    const parts = dir ? dir.split("/") : [];
    return parts.map((_, i) => parts.slice(0, parts.length - i).join("/")).concat("");
  };
  const nearest = (dir: string, kind: "layout" | "loading" | "error" | "not-found") =>
    ancestors(dir).find((d) => dirs.get(d)?.[kind]);
  // `app/layout.tsx` exists (checked above): `app/` itself is every directory's last resort.
  const nearestLayout = (dir: string) => nearest(dir, "layout") ?? "";
  const relative = (from: string, to: string) => urlParts(to).slice(urlParts(from).length);
  const layoutId = (dir: string) => (dir ? dir : ROOT_ID);

  const layouts: LayoutNode[] = [];
  const pages: PageNode[] = [];
  const canonical = new Map<string, string>();
  for (const [dir, entry] of [...dirs].sort(([a], [b]) => compare(a, b))) {
    const own = segments(dir);
    if (entry.layout && own.at(-1)?.kind === "splat")
      throw new Error(`${entry.layout}: A catch-all segment cannot hold a layout`);
    if (entry.layout && dir) {
      const parent = nearestLayout(dir.split("/").slice(0, -1).join("/"));
      const path = relative(parent, dir).join("/");
      layouts.push({
        id: dir,
        parent: layoutId(parent),
        path: path || undefined,
        file: entry.layout,
      });
    }
    if (!entry.page) continue;
    const params = own.filter((s) => s.kind !== "static" && s.kind !== "group").map((s) => s.name);
    const last = own.at(-1);
    const splat = last?.kind === "splat" ? last.name : undefined;
    const repeated = params.find((p, i) => params.indexOf(p) !== i);
    if (repeated) throw new Error(`${entry.page}: Repeated route parameter "${repeated}"`);
    const url = "/" + urlParts(dir).join("/");
    // Catch-all and parameter routes may share a prefix: TanStack ranks `$id` first.
    const key = url.replace(/\$[^/]+/g, "$").replace(/\/\$$/, splat ? "/*" : "/$");
    const existing = canonical.get(key);
    if (existing) throw new Error(`Route collision ${key}: ${existing} and ${entry.page}`);
    canonical.set(key, entry.page);
    const parent = nearestLayout(dir);
    pages.push({
      id: "/" + dir,
      parent: layoutId(parent),
      path: relative(parent, dir).join("/") || "/",
      url,
      params,
      file: entry.page,
      loading: dirs.get(nearest(dir, "loading") ?? "")?.loading,
      error: dirs.get(nearest(dir, "error") ?? "")?.error,
      notFound: dirs.get(nearest(dir, "not-found") ?? "")?.["not-found"],
      splat,
      layouts: ancestors(dir)
        .reverse()
        .flatMap((d) => dirs.get(d)?.layout ?? []),
    });
  }
  return { root, notFound: dirs.get("")?.["not-found"], layouts, pages };
}

export const ROUTE_TREE_FILE = "app/routeTree.gen.ts";

/**
 * Renders the typed TanStack route tree module for `graph`. Literal paths let
 * TanStack infer params, `to` targets and loader data; the `Register` declaration
 * types the re-exported hooks for this application only. `staleTimes` holds the
 * milliseconds a page declared with `export const staleTime`, by page file.
 */
export function renderRouteTree(
  graph: RouteGraph,
  staleTimes: ReadonlyMap<string, number> = new Map(),
): string {
  const quote = JSON.stringify;
  const importPath = (file: string) => "./" + file.replace(/^app\//, "").replace(/\.tsx$/, "");
  const paramsOf = (id: string) => [...id.matchAll(/\[(\w+)\]/g)].map((m) => m[1]);
  const files = (page: PageNode) =>
    Object.entries({ Loading: page.loading, Error: page.error, NotFound: page.notFound }).flatMap(
      ([prefix, file]) =>
        file ? [`${prefix[0].toLowerCase() + prefix.slice(1)}: ${component(file, prefix)}`] : [],
    );
  const imports: string[] = [];
  const component = (() => {
    const names = new Map<string, string>();
    return (file: string, prefix: string) => {
      let name = names.get(file);
      if (!name) {
        name = `${prefix}${names.size}`;
        names.set(file, name);
        imports.push(`import ${name} from ${quote(importPath(file))};`);
      }
      return name;
    };
  })();
  const routes: string[] = [];
  const children = new Map<string, string[]>();
  const names = new Map<string, string>([[ROOT_ID, "rootRoute"]]);
  const adopt = (parent: string, name: string) =>
    children.set(parent, [...(children.get(parent) ?? []), name]);
  const rootLayout = component(graph.root, "Layout");
  const rootNotFound = graph.notFound ? `, ${component(graph.notFound, "NotFound")}` : "";
  graph.layouts.forEach((layout, i) => {
    const name = `layout${i}Route`;
    names.set(layout.id, name);
    const location = layout.path
      ? `path: ${quote(layout.path)}`
      : `id: ${quote(`_${layout.id.replace(/[()]/g, "").replace(/\W+/g, "_")}`)}`;
    routes.push(
      `const ${name} = createRoute({\n  getParentRoute: () => ${names.get(layout.parent)},\n  ${location},\n  ...layoutRoute(${component(layout.file, "Layout")}, ${quote(paramsOf(layout.id))}),\n});`,
    );
    adopt(layout.parent, name);
  });
  graph.pages.forEach((page, i) => {
    const name = `page${i}Route`;
    const options = [...files(page), ...(page.splat ? [`splat: ${quote(page.splat)}`] : [])];
    const extra = options.length ? `, { ${options.join(", ")} }` : "";
    const splat = page.splat ? `, ${quote(page.splat)}` : "";
    const staleTime = staleTimes.get(page.file);
    routes.push(
      `const ${name} = createRoute({\n  getParentRoute: () => ${names.get(page.parent)},\n  path: ${quote(page.path)},\n${staleTime === undefined ? "" : `  staleTime: ${staleTime},\n`}  loader: (ctx) => loadPage(ctx, ${quote(page.id)}, ${quote(page.params)}${splat}),\n  ...pageRoute(${quote(page.params)}${extra}),\n});`,
    );
    adopt(page.parent, name);
  });
  const tree = (id: string, name: string): string => {
    const own = children.get(id);
    if (!own) return name;
    const ids = new Map([...names].map(([key, value]) => [value, key]));
    return `${name}.addChildren([${own.map((child) => tree(ids.get(child) ?? "", child)).join(", ")}])`;
  };
  return `// Generated by \`airtty build\` from app/. Do not edit: route files are the source.
import { createRoute } from "@tanstack/react-router";
import {
  layoutRoute,
  loadPage,
  pageRoute,
  rootRoute as createRootRoute,
  type TerminalRouter,
} from "airtty/route-tree";
${imports.join("\n")}

const rootRoute = createRootRoute(${rootLayout}${rootNotFound});
${routes.join("\n")}

export const routeTree = ${tree(ROOT_ID, "rootRoute")};

declare module "@tanstack/react-router" {
  interface Register {
    router: TerminalRouter<typeof routeTree>;
  }
}
`;
}
