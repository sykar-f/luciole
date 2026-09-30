/**
 * Application bundles (`.luciole/app/`, docs/EMBEDDING.md step 3): an application's
 * Client Components, route tree and Server Function stubs, without the runtime. A host
 * evaluates one per pane against its own runtime, through the ABI (src/abi.ts): no copy
 * of the luciole runtime, TanStack Router or the keymap per pane, and a pane's hooks read
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
import * as z from "zod/mini";
import { APP_MANIFEST, AppManifest } from "./abi";
import { applicationOf, checkAbi, evaluateAppBundle, type AppBundle } from "./app-evaluate";
import { connect } from "./connect";
import { InstanceKey } from "./instance";
import { verifyManifest } from "./publisher";
import type { Application, ApplicationOptions } from "./client";

export { applicationOf, runtimeSpecifiers, type AppBundle } from "./app-evaluate";

// Declared Node built-ins come from Node's own loader, never from a path.
const requireBuiltin = createRequire(import.meta.url);

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
/**
 * Reads and checks the bundle in `directory` (its manifest, its ABI, its hash), then
 * evaluates it: a new module instance on every call. Undeclared built-ins are refused.
 */
export async function loadAppBundle(
  directory: string,
  { publisher }: { publisher?: PublisherCheck } = {},
): Promise<AppBundle> {
  const manifestFile = join(directory, APP_MANIFEST);
  const manifestBlob = Bun.file(manifestFile);
  if (!(await manifestBlob.exists()))
    throw new Error(
      `${directory} has no application bundle: build the application with luciole build ` +
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
  checkAbi(manifest, directory);
  const file = join(directory, manifest.bundle);
  const code = await Bun.file(file).text();
  return evaluateAppBundle({
    manifest,
    publisher: fingerprint,
    code,
    sha256: createHash("sha256").update(code).digest("hex"),
    file,
    directory: dirname(file),
    // The file name gives stack traces their source (and its linked source map).
    compile: (source, filename): unknown => runInThisContext(source, { filename }),
    builtin: (specifier): unknown => (isBuiltin(specifier) ? requireBuiltin(specifier) : undefined),
  });
}

export type OpenApplicationOptions = Omit<
  ApplicationOptions,
  "url" | "fetch" | "routeTree" | "buildId" | "resolveModule" | "instance"
> & {
  /** An application bundle: `<app>/.luciole/app`. */
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
