import { test, expect } from "bun:test";
import { createHash } from "node:crypto";
import { chmod, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { AppManifest } from "../packages/core/src/abi";
import { loadAppBundle } from "../packages/core/src/app-bundle";
import { appRoutes } from "../packages/core/src/app-routes";
import { build } from "../packages/core/src/build";
import { Capabilities } from "../packages/core/src/capabilities";
import { messageOf } from "../packages/core/src/guards";
import {
  generatePublisherKey,
  publisherIdentity,
  readPublisherKey,
  verifyManifest,
} from "../packages/core/src/publisher";
import { launch, rejectionOf } from "./helpers";

const PERMISSIONS = 0o777;
const latency = resolve("examples/latency");
const bundleDir = join(latency, ".luciole/app");
const manifestFile = join(bundleDir, "manifest.json");
const readManifestFile = async () =>
  AppManifest.parse(JSON.parse(await readFile(manifestFile, "utf8")));

async function withKeys<T>(run: (env: NodeJS.ProcessEnv) => Promise<T>) {
  const home = await mkdtemp(join(tmpdir(), "luciole-keys-"));
  try {
    return await run({ XDG_CONFIG_HOME: home, HOME: home });
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

test("a publisher key is created once, private, and refused when others can read it", async () => {
  await withKeys(async (env) => {
    expect(() => readPublisherKey(env)).toThrow("luciole keys generate");
    const created = generatePublisherKey(env);
    expect(created.file).toBe(join(env.XDG_CONFIG_HOME ?? "", "luciole/keys/publisher.pem"));
    expect((await stat(created.file)).mode & PERMISSIONS).toBe(0o600);
    expect((await stat(dirname(created.file))).mode & PERMISSIONS).toBe(0o700);
    expect(created.fingerprint).toMatch(/^SHA256:[A-Za-z0-9+/]{43}$/);
    expect(() => generatePublisherKey(env)).toThrow("Move it away first");
    expect(publisherIdentity(readPublisherKey(env))).toEqual(created);
    await chmod(created.file, 0o644);
    expect(() => readPublisherKey(env)).toThrow("readable by others");
    // LUCIOLE_PUBLISHER_KEY points elsewhere, for a CI secret.
    const other = join(env.XDG_CONFIG_HOME ?? "", "ci.pem");
    expect(generatePublisherKey({ ...env, LUCIOLE_PUBLISHER_KEY: other }).file).toBe(other);
  });
});

test("a signed bundle verifies whatever its JSON looks like, and any altered field fails", async () => {
  await withKeys(async (env) => {
    generatePublisherKey(env);
    const key = readPublisherKey(env);
    await build(latency, undefined, { signBundle: key });
    const manifest = await readManifestFile();
    const { fingerprint } = publisherIdentity(key);
    expect(verifyManifest(manifest)).toBe(fingerprint);
    // The canonical encoding, not the received JSON: key order and spacing are free.
    const reordered = Object.fromEntries(Object.entries(manifest).reverse());
    await Bun.write(manifestFile, JSON.stringify(reordered));
    expect((await loadAppBundle(bundleDir)).publisher).toBe(fingerprint);
    const altered: Partial<AppManifest>[] = [
      { name: "other" },
      { buildId: "0".repeat(manifest.buildId.length) },
      { abi: "0-0000000000000000" },
      { sha256: "0".repeat(64) },
      { size: manifest.size + 1 },
      { builtins: ["child_process"] },
      { capabilities: { ...Capabilities.parse({}), pty: true } },
    ];
    for (const change of altered)
      expect(() => verifyManifest({ ...manifest, ...change })).toThrow("does not verify");
    // Another key cannot sign in this key's name.
    const signature = manifest.signature;
    if (!signature) throw new Error("expected a signature");
    await withKeys(async (other) => {
      generatePublisherKey(other);
      const foreign = readPublisherKey(other);
      expect(() =>
        verifyManifest({ ...manifest, signature: { ...signature, publicKey: foreign.publicKey } }),
      ).toThrow("does not verify");
    });
    // What step 5 plugs in: a required signature, and a trust decision on the key.
    await Bun.write(manifestFile, JSON.stringify(manifest));
    const seen: string[] = [];
    await loadAppBundle(bundleDir, {
      publisher: { required: true, trust: (f) => void seen.push(f) },
    });
    expect(seen).toEqual([fingerprint]);
    const refused = await rejectionOf(
      loadAppBundle(bundleDir, {
        publisher: {
          trust: () => {
            throw new Error("publisher key changed");
          },
        },
      }),
    );
    expect(messageOf(refused)).toBe("publisher key changed");
  });
  // Unsigned: accepted by default, refused when a signature is required.
  await build(latency);
  expect((await loadAppBundle(bundleDir)).publisher).toBeUndefined();
  expect(
    messageOf(await rejectionOf(loadAppBundle(bundleDir, { publisher: { required: true } }))),
  ).toContain("not signed by its publisher");
}, 60_000);

test("the Server serves its manifest and its bundle by hash, with no session or build", async () => {
  await withKeys(async (env) => {
    generatePublisherKey(env);
    await build(latency, undefined, { signBundle: readPublisherKey(env) });
  });
  const written = await readFile(manifestFile, "utf8");
  const { sha256 } = AppManifest.parse(JSON.parse(written));
  // A token makes every application route require the bearer: these two stay public.
  const server = await launch(join(latency, ".luciole/server/index.js"), {
    LUCIOLE_TOKEN: "secret",
  });
  try {
    const manifest = await fetch(`${server.url}/manifest`);
    expect(manifest.status).toBe(200);
    expect(await manifest.text()).toBe(written);
    const bundle = await fetch(`${server.url}/bundle/${sha256}`);
    expect(bundle.status).toBe(200);
    expect(bundle.headers.get("cache-control")).toContain("immutable");
    const bytes = new Uint8Array(await bundle.arrayBuffer());
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(sha256);
    expect((await fetch(`${server.url}/bundle/${"0".repeat(64)}`)).status).toBe(404);
    // Everything else still asks for the build and the bearer.
    expect((await fetch(`${server.url}/render?route=/`)).status).not.toBe(200);
  } finally {
    await server.stop();
  }
}, 60_000);

test("without a bundle, both routes answer 404 rather than the build check", () => {
  const routes = appRoutes(join(tmpdir(), "luciole-no-such-bundle"));
  const get = (path: string) =>
    routes(new Request(`http://x${path}`), new URL(`http://x${path}`))?.status;
  expect(get("/manifest")).toBe(404);
  expect(get(`/bundle/${"a".repeat(64)}`)).toBe(404);
  expect(get("/render")).toBeUndefined();
});
