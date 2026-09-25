/**
 * Application bundles evaluated against this runtime (docs/EMBEDDING.md step 3), without
 * anything of where the bundle came from: the checks a manifest and its code must pass,
 * the ABI table the bundle's `require` resolves, and the Application of the result. A host
 * brings its own reading, hashing and evaluation: src/app-bundle.ts from disk with Node's,
 * the web runtime over fetch with the page's (docs/WEB.md, W3).
 */
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
import { ABI_KEY, type AbiSpecifier, type AppManifest } from "./abi";
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

/** A bundle refused before it runs: built for another runtime. `where` names it. */
export function checkAbi(manifest: AppManifest, where: string) {
  if (manifest.abi !== ABI_KEY)
    throw new Error(
      `${where}: built for runtime ABI ${manifest.abi}, this Client runs ${ABI_KEY}: rebuild the application or update the Client`,
    );
}

export type Evaluation = {
  manifest: AppManifest;
  publisher: string | undefined;
  code: string;
  /** The code's SHA-256, hex, as the host computed it. */
  sha256: string;
  /** The code's name, for messages and stack traces (a path or a URL). */
  file: string;
  /** Where it is: the bundle's `__dirname`. */
  directory: string;
  /** Turns the code into its `bun-cjs` wrapper function, named `file`. */
  compile: (code: string, file: string) => unknown;
  /**
   * A Node built-in the manifest declares, or `undefined` when `specifier` is not one;
   * absent where there are none.
   */
  builtin?: (specifier: string) => unknown;
};

/**
 * Checks `code` against its manifest, then evaluates it: a new module instance on every
 * call. Its `require` is the ABI table, then the built-ins the manifest declares.
 */
export function evaluateAppBundle(evaluation: Evaluation): AppBundle {
  const { manifest, code, file, directory, builtin } = evaluation;
  if (evaluation.sha256 !== manifest.sha256)
    throw new Error(`${file} does not match its manifest (sha256)`);
  const require = (specifier: string): unknown => {
    if (specifier in RUNTIME) return Reflect.get(RUNTIME, specifier);
    if (builtin && manifest.builtins.includes(specifier)) {
      const found = builtin(specifier);
      if (found !== undefined) return found;
    }
    throw new Error(`${file} requires ${specifier}, outside the runtime ABI`);
  };
  const wrapper = evaluation.compile(code, file);
  if (typeof wrapper !== "function") throw new Error(`${file} is not a bun-cjs bundle`);
  const module = { exports: {} };
  Reflect.apply(wrapper, undefined, [module.exports, require, module, file, directory]);
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
    publisher: evaluation.publisher,
    buildId: manifest.buildId,
    routeTree: exported.routeTree,
    modules,
    actions: exported.actions,
  };
}

/**
 * An Application of an evaluated bundle: its routes and modules, its Server Functions and
 * `host` bound to it. `openApplication`, a sandboxed Client (src/sandbox/child.ts) and the
 * web runtime use it.
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
