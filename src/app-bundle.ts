/**
 * Application bundles (`.airtty/app/`, docs/EMBEDDING.md step 3): an application's
 * Client Components, route tree and Server Function stubs, without the runtime. A host
 * evaluates one per pane against its own runtime, through the ABI (src/abi.ts): no copy
 * of the airtty runtime, TanStack Router or the keymap per pane, and a pane's hooks read
 * the host's contexts.
 *
 * Format: Bun's `bun-cjs`, `(function (exports, require, module, …) {…})`. The host
 * passes its own `require`, and that table *is* the ABI: no node_modules, no resolution
 * on disk, and a specifier outside it fails when the bundle loads.
 */
import { createHash } from "node:crypto";
import { createRequire, isBuiltin } from "node:module";
import { dirname, join } from "node:path";
import { runInThisContext } from "node:vm";
import * as React from "react";
import * as ReactJsx from "react/jsx-runtime";
import * as OpenTuiCore from "@opentui/core";
import * as OpenTuiReact from "@opentui/react";
import * as OpenTuiJsx from "@opentui/react/jsx-runtime";
import * as Keymap from "@opentui/keymap";
import * as KeymapReact from "@opentui/keymap/react";
import * as TanStack from "@tanstack/react-router";
import type { AnyRoute } from "@tanstack/react-router";
import * as z from "zod/mini";
import * as AirttyClient from "./client";
import * as AirttyRouteTree from "./route-tree";
import { ABI_KEY, APP_MANIFEST, AppManifest, type AbiSpecifier } from "./abi";
import { connect } from "./connect";
import { InstanceKey } from "./instance";
import { verifyManifest } from "./publisher";
import type { Application, ApplicationOptions } from "./client";

/** What each ABI specifier is in this runtime: the modules this very copy runs. */
const RUNTIME: Record<AbiSpecifier, unknown> = {
  "airtty/client": AirttyClient,
  "airtty/route-tree": AirttyRouteTree,
  "@tanstack/react-router": TanStack,
  react: React,
  "react/jsx-runtime": ReactJsx,
  "@opentui/core": OpenTuiCore,
  "@opentui/react": OpenTuiReact,
  "@opentui/react/jsx-runtime": OpenTuiJsx,
  "@opentui/keymap": Keymap,
  "@opentui/keymap/react": KeymapReact,
  "zod/mini": z,
};
export const runtimeSpecifiers = () => Object.keys(RUNTIME);

// Declared Node built-ins come from Node's own loader, never from a path.
const requireBuiltin = createRequire(import.meta.url);

type Actions = { bind: (app: Application) => void };
export type AppBundle = {
  manifest: AppManifest;
  /** Fingerprint of the key that signed the manifest; `undefined` when unsigned. */
  publisher: string | undefined;
  buildId: string;
  routeTree: AnyRoute;
  modules: ReadonlyMap<string, Record<string, unknown>>;
  actions: Actions;
};
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;
const isRoute = (value: unknown): value is AnyRoute =>
  isRecord(value) && typeof value.addChildren === "function";
const isActions = (value: unknown): value is Actions =>
  isRecord(value) && typeof value.bind === "function";

/**
 * Reads and checks the bundle in `directory` (its manifest, its ABI, its hash), then
 * evaluates it: a new module instance on every call. Undeclared built-ins are refused.
 */
/**
 * What a host asks of a bundle's publisher. Step 5 (generic Client) passes
 * `{ required: true, trust }` for a downloaded bundle, `trust` pinning the key per origin
 * on first use and refusing a changed one; a local bundle may be unsigned.
 */
export type PublisherCheck = {
  /** Refuse an unsigned manifest. */
  required?: boolean;
  /** Called with the verified key's fingerprint, before any evaluation; throws to refuse. */
  trust?: (fingerprint: string, manifest: AppManifest) => void | Promise<void>;
};
export async function loadAppBundle(
  directory: string,
  { publisher }: { publisher?: PublisherCheck } = {},
): Promise<AppBundle> {
  const manifestFile = join(directory, APP_MANIFEST);
  const manifestBlob = Bun.file(manifestFile);
  if (!(await manifestBlob.exists()))
    throw new Error(
      `${directory} has no application bundle: build the application with airtty build ` +
        "(--app-bundle names why one could not be emitted, a top-level await in Client code)",
    );
  const parsed = AppManifest.safeParse(await manifestBlob.json());
  if (!parsed.success) throw new Error(`${manifestFile}: ${z.prettifyError(parsed.error)}`);
  const manifest = parsed.data;
  // Signed right or refused; unsigned only if the host accepts it (src/publisher.ts).
  const fingerprint = verifyManifest(manifest);
  if (!fingerprint && publisher?.required)
    throw new Error(`${directory}: the manifest is not signed by its publisher`);
  if (fingerprint) await publisher?.trust?.(fingerprint, manifest);
  if (manifest.abi !== ABI_KEY)
    throw new Error(
      `${directory}: built for runtime ABI ${manifest.abi}, this Client runs ${ABI_KEY}: rebuild the application or update the Client`,
    );
  const file = join(directory, manifest.bundle);
  const code = await Bun.file(file).text();
  if (createHash("sha256").update(code).digest("hex") !== manifest.sha256)
    throw new Error(`${file} does not match its manifest (sha256)`);
  const require = (specifier: string): unknown => {
    if (specifier in RUNTIME) return Reflect.get(RUNTIME, specifier);
    if (isBuiltin(specifier) && manifest.builtins.includes(specifier))
      return requireBuiltin(specifier);
    throw new Error(`${file} requires ${specifier}, outside the runtime ABI`);
  };
  // The file name gives stack traces their source (and its linked source map).
  const wrapper: unknown = runInThisContext(code, { filename: file });
  if (typeof wrapper !== "function") throw new Error(`${file} is not a bun-cjs bundle`);
  const module = { exports: {} };
  Reflect.apply(wrapper, undefined, [module.exports, require, module, file, dirname(file)]);
  const exported: unknown = module.exports;
  if (
    !isRecord(exported) ||
    exported.buildId !== manifest.buildId ||
    !isRoute(exported.routeTree) ||
    !isRecord(exported.modules) ||
    !isActions(exported.actions)
  )
    throw new Error(`${file} does not export its build, route tree, modules and actions`);
  const modules = new Map<string, Record<string, unknown>>();
  for (const [id, value] of Object.entries(exported.modules))
    if (isRecord(value)) modules.set(id, value);
  return {
    manifest,
    publisher: fingerprint,
    buildId: manifest.buildId,
    routeTree: exported.routeTree,
    modules,
    actions: exported.actions,
  };
}

export type OpenApplicationOptions = Omit<
  ApplicationOptions,
  "url" | "fetch" | "routeTree" | "buildId" | "resolveModule" | "instance"
> & {
  /** An application bundle: `<app>/.airtty/app`. */
  bundle: string;
  /** Its Server: `http(s)://…`, `unix:/path`, `ssh://…` (src/connect.ts). */
  url: string;
  /** The pane's instance key; a new one by default. */
  instance?: string;
  /** What the bundle's signature must satisfy (`PublisherCheck`); by default none. */
  publisher?: PublisherCheck;
};
const INSTANCE_BYTES = 4;
const HEX = 16;
const newInstance = () =>
  `p${[...crypto.getRandomValues(new Uint8Array(INSTANCE_BYTES))].map((b) => b.toString(HEX).padStart(2, "0")).join("")}`;

/**
 * An Application of an evaluated bundle: its routes and modules, its Server Functions and
 * `host` bound to it. `openApplication` and a sandboxed Client (src/sandbox/child.ts) use it.
 */
export function applicationOf(
  loaded: AppBundle,
  options: Omit<ApplicationOptions, "routeTree" | "buildId" | "resolveModule">,
) {
  const app = AirttyClient.createApplication({
    title: loaded.manifest.name.toUpperCase(),
    ...options,
    routeTree: loaded.routeTree,
    buildId: loaded.buildId,
    resolveModule: (id) => {
      const found = loaded.modules.get(id);
      if (!found) throw new Error(`Unknown module ${id}`);
      return found;
    },
  });
  loaded.actions.bind(app);
  return app;
}

/**
 * An Application for a pane: its bundle evaluated against this runtime (its own modules
 * and Server Function binding), an instance key, the connection to its Server. Disposing
 * the Application closes that connection.
 */
export async function openApplication(options: OpenApplicationOptions): Promise<Application> {
  const { bundle, url, instance = newInstance(), publisher, ...rest } = options;
  InstanceKey.parse(instance);
  const loaded = await loadAppBundle(bundle, { publisher });
  const connection = await connect(url);
  try {
    const app = applicationOf(loaded, {
      ...rest,
      url: connection.url,
      fetch: connection.fetch,
      instance,
    });
    app.onDispose(() => connection.close());
    return app;
  } catch (error) {
    connection.close();
    throw error;
  }
}
