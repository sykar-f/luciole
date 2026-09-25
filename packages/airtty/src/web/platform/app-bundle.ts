/**
 * Application bundles in a page (src/app-bundle.ts): fetched from their Server
 * (`/manifest`, `/bundle/<sha256>`), hashed with SubtleCrypto, evaluated as a blob
 * module. The checks, the ABI table and the Application are src/app-evaluate.ts's.
 */
import * as z from "zod/mini";
import { AppManifest } from "../../abi";
import { applicationOf, checkAbi, evaluateAppBundle, type AppBundle } from "../../app-evaluate";
import { InstanceKey } from "../../instance";
import type { Application, ApplicationOptions } from "../../client";

export { applicationOf, runtimeSpecifiers, type AppBundle } from "../../app-evaluate";

/** Same shape as src/app-bundle.ts; a page trusts its origin (docs/WEB.md, decision 1). */
export type PublisherCheck = {
  required?: boolean;
  trust?: (fingerprint: string, manifest: AppManifest) => void | Promise<void>;
};

const HEX = 16;
const hex = (bytes: ArrayBuffer) =>
  [...new Uint8Array(bytes)].map((b) => b.toString(HEX).padStart(2, "0")).join("");

async function text(url: URL) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url.href}: ${response.status} ${response.statusText}`);
  return response.text();
}

/**
 * The bundle's `bun-cjs` wrapper, evaluated as a module of its own (no `eval`: a page's
 * CSP may allow `blob:` scripts and still forbid it). Its URL names it in stack traces.
 */
async function moduleOf(code: string, name: string): Promise<unknown> {
  const url = URL.createObjectURL(
    new Blob([`export default ${code}\n//# sourceURL=${name}`], { type: "text/javascript" }),
  );
  try {
    const module: unknown = await import(url);
    return typeof module === "object" && module !== null
      ? Reflect.get(module, "default")
      : undefined;
  } finally {
    URL.revokeObjectURL(url);
  }
}

/**
 * The bundle a Server at `server` serves, checked and evaluated: a new module instance on
 * every call. A publisher signature is not verified here: the page and the bundle come
 * from the same origin, which TLS authenticates.
 */
export async function loadAppBundle(
  server: string | URL,
  {
    publisher,
    files,
  }: {
    publisher?: PublisherCheck;
    /** Static copies of `.airtty/app` instead of the Server's routes (an in-browser Server). */
    files?: URL;
  } = {},
): Promise<AppBundle> {
  const manifestUrl = files ? new URL("manifest.json", files) : new URL("manifest", server);
  const parsed = AppManifest.safeParse(JSON.parse(await text(manifestUrl)));
  if (!parsed.success) throw new Error(`${manifestUrl.href}: ${z.prettifyError(parsed.error)}`);
  const manifest = parsed.data;
  if (publisher?.required)
    throw new Error(`${manifestUrl.href}: publisher signatures are not verified in a page`);
  checkAbi(manifest, manifestUrl.href);
  const file = files
    ? new URL(manifest.bundle, files)
    : new URL(`bundle/${manifest.sha256}`, server);
  const code = await text(file);
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(code));
  const wrapper = await moduleOf(code, file.href);
  return evaluateAppBundle({
    manifest,
    publisher: undefined,
    code,
    sha256: hex(digest),
    file: file.href,
    directory: new URL(".", file).href,
    compile: () => wrapper,
  });
}

export type OpenApplicationOptions = Omit<
  ApplicationOptions,
  "url" | "fetch" | "routeTree" | "buildId" | "resolveModule" | "instance"
> & {
  /** In a page, the bundle comes from its Server: this is ignored. */
  bundle?: string;
  /** Its Server, on this page's origin. */
  url: string;
  instance?: string;
  publisher?: PublisherCheck;
};
const INSTANCE_BYTES = 4;
const newInstance = () =>
  `p${[...crypto.getRandomValues(new Uint8Array(INSTANCE_BYTES))].map((b) => b.toString(HEX).padStart(2, "0")).join("")}`;

/** An Application for a pane, from the bundle its Server serves. */
export async function openApplication(options: OpenApplicationOptions): Promise<Application> {
  const { bundle: _bundle, url, instance = newInstance(), publisher, ...rest } = options;
  InstanceKey.parse(instance);
  const loaded = await loadAppBundle(url, { publisher });
  return applicationOf(loaded, { ...rest, url, instance });
}
