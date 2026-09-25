import { dirname, join } from "node:path";
import * as react from "react";
import * as reactJsx from "react/jsx-runtime";
import * as opentuiCore from "@opentui/core";
import * as opentuiReact from "@opentui/react";
import * as opentuiJsx from "@opentui/react/jsx-runtime";
import * as keymap from "@opentui/keymap";
import * as keymapReact from "@opentui/keymap/react";
import * as zod from "zod";
import * as zodMini from "zod/mini";
import { logMessages } from "../../packages/airtty/src/bundle-errors";
import type { AbiSpecifier } from "./abi";
import type * as RuntimeEntry from "./runtime-entry";

const OUT = join(import.meta.dir, ".out");
const root = join(import.meta.dir, "../..");
// Same redirect as src/build.ts: Bun's "bun" condition selects TanStack's server build,
// which skips the transition machinery the terminal Client needs.
const tanstackClientBuild = join(
  dirname(Bun.resolveSync("@tanstack/router-core/isServer", root)),
  "client.js",
);
// Left to node_modules so the host (this probe) and the runtime bundle share one copy;
// only the airtty runtime and TanStack need bundling.
const EXTERNAL = [
  "react",
  "react-dom",
  "react-reconciler",
  "react-server-dom-webpack",
  "@opentui/*",
  "zod",
];

export type Runtime = typeof RuntimeEntry;
const isRuntime = (value: unknown): value is Runtime =>
  typeof value === "object" &&
  value !== null &&
  ["airttyClient", "airttyRouteTree", "runtimeContext", "flight", "tanstack"].every(
    (key) => key in value,
  );

/**
 * Builds the generic Client's runtime (the airtty runtime and TanStack) and imports it.
 * A real generic Client ships this bundle compiled in; here it is rebuilt per run.
 */
export async function loadRuntime() {
  const started = performance.now();
  const result = await Bun.build({
    entrypoints: [join(import.meta.dir, "runtime-entry.ts")],
    outdir: OUT,
    naming: "runtime.js",
    target: "bun",
    external: EXTERNAL,
    plugins: [
      {
        name: "tanstack-client",
        setup(b) {
          b.onResolve({ filter: /^@tanstack\/router-core\/isServer$/ }, () => ({
            path: tanstackClientBuild,
          }));
        },
      },
    ],
  });
  if (!result.success) throw new Error(logMessages(result.logs));
  const buildMs = performance.now() - started;
  const module: unknown = await import(join(OUT, "runtime.js"));
  if (!isRuntime(module)) throw new Error("runtime.js does not export the runtime ABI");
  return { runtime: module, buildMs, bytes: Bun.file(join(OUT, "runtime.js")).size };
}

/** What each ABI specifier resolves to; `airtty/client` may be replaced per origin. */
export function abiModules(runtime: Runtime): Record<AbiSpecifier, unknown> {
  return {
    "airtty/client": runtime.airttyClient,
    "airtty/route-tree": runtime.airttyRouteTree,
    "@tanstack/react-router": runtime.tanstack,
    react,
    "react/jsx-runtime": reactJsx,
    "@opentui/core": opentuiCore,
    "@opentui/react": opentuiReact,
    "@opentui/react/jsx-runtime": opentuiJsx,
    "@opentui/keymap": keymap,
    "@opentui/keymap/react": keymapReact,
    zod,
    "zod/mini": zodMini,
  };
}
