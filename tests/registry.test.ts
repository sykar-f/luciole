import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync, statSync } from "node:fs";
import { chmod, cp, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { z } from "zod";
import { hostTarget } from "../packages/airtty/src/compile";
import { sandboxSupported } from "../packages/airtty/src/sandbox/runtime";
import { messageOf } from "../packages/airtty/src/guards";
import { launch, resolveTarget } from "../packages/airtty/src/launcher";
import type { Directories } from "../packages/airtty/src/launcher/paths";
import {
  findInstalled,
  install,
  listInstalled,
  remove,
  update,
} from "../packages/airtty/src/registry/apps";
import { npmRegistry } from "../packages/airtty/src/registry/npm";
import { packApp } from "../packages/airtty/src/registry/pack";
import { rejectionOf } from "./helpers";

let work: string, directories: Directories, server: ReturnType<typeof Bun.serve>;
/** What the fake registry serves: packuments by name, tarballs by path. */
const packuments = new Map<
  string,
  { name: string; "dist-tags": Record<string, string>; versions: Record<string, unknown> }
>();
const tarballs = new Map<string, Uint8Array>();
let tamper = false;

const PackageJson = z.looseObject({ name: z.string(), version: z.string() });

/** A stand-in for an app binary: its identity, and a record of how it was run. */
async function fakeBinary(name: string, buildId: string, target: string) {
  const file = join(work, "binaries", `${name}-${buildId}-${target}`);
  await mkdir(join(work, "binaries"), { recursive: true });
  await Bun.write(
    file,
    `#!/bin/sh\n# airtty-binary:1:${name}:${buildId}:${target};\necho "${buildId} $*" >> "${join(work, "runs.log")}"\n`,
  );
  await chmod(file, 0o755);
  return file;
}

/** `npm publish`, as far as the registry's read API shows it. */
async function publish(options: { version: string; buildId: string; targets?: string[] }) {
  const binaries = await Promise.all(
    (options.targets ?? [hostTarget()]).map((target) =>
      fakeBinary("notes", options.buildId, target),
    ),
  );
  const outdir = join(work, `npm-${options.version}`);
  const directories = await packApp({
    package: "@ada/notes",
    version: options.version,
    description: "Notes in the terminal",
    binaries,
    outdir,
  });
  for (const directory of directories) {
    const manifest = PackageJson.parse(
      JSON.parse(await readFile(join(directory, "package.json"), "utf8")),
    );
    const staging = await mkdtemp(join(work, "tar-"));
    await cp(directory, join(staging, "package"), { recursive: true });
    const tgz = Bun.spawnSync(["tar", "czf", "-", "-C", staging, "package"]).stdout;
    const path = `/tarballs/${basename(directory)}-${manifest.version}.tgz`;
    tarballs.set(path, new Uint8Array(tgz));
    const integrity = `sha512-${new Bun.CryptoHasher("sha512").update(tgz).digest("base64")}`;
    const existing = packuments.get(manifest.name) ?? {
      name: manifest.name,
      "dist-tags": {},
      versions: {},
    };
    existing.versions[manifest.version] = {
      ...manifest,
      dist: { tarball: `${server.url.origin}${path}`, integrity },
    };
    existing["dist-tags"].latest = manifest.version;
    packuments.set(manifest.name, existing);
  }
  return directories;
}

beforeAll(async () => {
  work = await mkdtemp(join(tmpdir(), "airtty-registry-"));
  directories = {
    apps: join(work, "data/apps"),
    git: join(work, "cache/git"),
    bundles: join(work, "cache/bundles"),
    config: join(work, "config"),
    state: join(work, "state"),
  };
  server = Bun.serve({
    port: 0,
    fetch(request) {
      const url = new URL(request.url);
      if (url.pathname === "/-/v1/search") {
        const text = url.searchParams.get("text") ?? "";
        const objects = [...packuments.values()]
          .filter(
            (p) => text.includes("keywords:airtty-app") && p.versions[p["dist-tags"].latest ?? ""],
          )
          .map((p) => ({ package: PackageJson.parse(p.versions[p["dist-tags"].latest ?? ""]) }))
          .filter(({ package: p }) => typeof p.keywords === "object");
        return Response.json({ objects });
      }
      const tarball = tarballs.get(url.pathname);
      if (tarball) {
        const bytes = new Uint8Array(tarball);
        if (tamper) bytes[bytes.length - 1] ^= 1;
        return new Response(bytes);
      }
      const packument = packuments.get(decodeURIComponent(url.pathname.slice(1)));
      return packument ? Response.json(packument) : new Response("Not found", { status: 404 });
    },
  });
});
afterAll(async () => {
  await server.stop(true);
  await rm(work, { recursive: true, force: true });
});

const options = () => ({
  registry: npmRegistry(server.url.origin),
  directories,
  log: () => {},
});

test("pack writes an app package and one package per target, esbuild style", async () => {
  const [linux, host, app] = await publish({
    version: "1.0.0",
    buildId: "aa11",
    targets: ["bun-linux-x64-musl", hostTarget()],
  });
  const read = async (directory = "") =>
    z.looseObject({}).parse(JSON.parse(await readFile(join(directory, "package.json"), "utf8")));
  expect(await read(app)).toMatchObject({
    name: "@ada/notes",
    version: "1.0.0",
    keywords: ["airtty-app"],
    airtty: {
      name: "notes",
      buildId: "aa11",
      binaries: {
        "bun-linux-x64-musl": "@ada/notes-linux-x64-musl",
        [hostTarget()]: `@ada/notes-${hostTarget().slice(4)}`,
      },
    },
    optionalDependencies: { "@ada/notes-linux-x64-musl": "1.0.0" },
  });
  expect(await read(linux)).toMatchObject({ os: ["linux"], cpu: ["x64"], libc: ["musl"] });
  expect(statSync(join(host ?? "", "bin/notes")).mode & 0o111).toBeTruthy();
  // One build per publication.
  const other = await fakeBinary("notes", "bb22", "bun-linux-arm64");
  expect(
    messageOf(
      await rejectionOf(
        packApp({
          package: "@ada/notes",
          version: "1.0.0",
          binaries: [await fakeBinary("notes", "aa11", hostTarget()), other],
          outdir: join(work, "never"),
        }),
      ),
    ),
  ).toContain("pack one build");
});

test("install, list, launch by name, update within the range, remove", async () => {
  const registry = options();
  const { installed } = await install({ name: "@ada/notes" }, registry);
  expect(installed).toMatchObject({
    app: "notes",
    version: "1.0.0",
    buildId: "aa11",
    target: hostTarget(),
  });
  const binary = join(directories.apps, "notes/aa11/notes");
  expect(existsSync(binary)).toBe(true);
  expect(await listInstalled(directories)).toEqual([installed]);
  // Installed: `notes` is the app, run with the arguments that follow it.
  expect(resolveTarget("notes", { directories })).toEqual({ kind: "installed", name: "notes" });
  expect(await launch("notes", { directories, args: ["--url", "ssh://h"] })).toBe(0);
  expect(await readFile(join(work, "runs.log"), "utf8")).toContain("aa11 --url ssh://h");
  // Already there: nothing downloaded again, even with --yes-less confirmation absent.
  expect((await install({ name: "@ada/notes" }, registry)).changed).toBe(false);
  await publish({ version: "1.1.0", buildId: "cc33" });
  const [moved] = await update([], registry);
  expect(moved).toMatchObject({
    changed: true,
    from: "1.0.0",
    installed: { version: "1.1.0", buildId: "cc33" },
  });
  expect(existsSync(binary)).toBe(false);
  expect(existsSync(join(directories.apps, "notes/cc33/notes"))).toBe(true);
  // A pinned range is kept by update.
  await install({ name: "@ada/notes", range: "~1.0.0" }, registry);
  expect((await findInstalled(directories, "notes"))?.version).toBe("1.0.0");
  await publish({ version: "1.2.0", buildId: "dd44" });
  const [kept] = await update(["notes"], registry);
  expect(kept).toMatchObject({ changed: false, installed: { version: "1.0.0" } });
  expect(messageOf(await rejectionOf(update(["ghost"], registry)))).toContain(
    "Not installed: ghost",
  );
  await remove("notes", directories);
  expect(await listInstalled(directories)).toEqual([]);
});

test("an npm spec is installed on launch once accepted; refusing installs nothing", async () => {
  const questions: string[] = [];
  const base = { directories, registry: npmRegistry(server.url.origin), log: () => {} };
  expect(resolveTarget("@ada/notes@^1.1", { directories })).toEqual({
    kind: "npm",
    spec: { name: "@ada/notes", range: "^1.1" },
  });
  const refused = await rejectionOf(
    launch("@ada/notes@^1.1", {
      ...base,
      confirm: async (question) => {
        questions.push(question);
        return false;
      },
    }),
  );
  expect(messageOf(refused)).toContain("was not installed");
  expect(questions[0]).toContain("Install @ada/notes@1.2.0 (notes)");
  expect(await listInstalled(directories)).toEqual([]);
  expect(await launch("@ada/notes@^1.1", { ...base, confirm: async () => true })).toBe(0);
  expect((await findInstalled(directories, "notes"))?.version).toBe("1.2.0");
  // Installed and matching: launched without asking the registry (here unreachable).
  expect(
    await launch("@ada/notes@^1.1", {
      ...base,
      registry: npmRegistry("http://127.0.0.1:1"),
      confirm: async () => false,
    }),
  ).toBe(0);
  await remove("notes", directories);
});

test("a tampered tarball, a missing target or a non-app package is refused", async () => {
  const registry = options();
  tamper = true;
  try {
    expect(messageOf(await rejectionOf(install({ name: "@ada/notes" }, registry)))).toContain(
      "does not match the integrity",
    );
  } finally {
    tamper = false;
  }
  expect(existsSync(join(directories.apps, "notes/installed.json"))).toBe(false);
  expect(
    messageOf(
      await rejectionOf(
        install({ name: "@ada/notes" }, { ...registry, target: "bun-linux-arm64" }),
      ),
    ),
  ).toContain("has no binary for bun-linux-arm64");
  expect(
    messageOf(await rejectionOf(install({ name: "@ada/notes-linux-x64-musl" }, registry))),
  ).toContain('is not an airtty app: no "airtty" field');
  expect(messageOf(await rejectionOf(install({ name: "@ada/ghost" }, registry)))).toContain(
    "@ada/ghost is not on",
  );
  expect(
    messageOf(await rejectionOf(install({ name: "@ada/notes", range: "^9" }, registry))),
  ).toContain("No version of @ada/notes matches @ada/notes@^9");
});

test("search lists published apps only", async () => {
  const found = await npmRegistry(server.url.origin).search("notes");
  expect(found).toEqual([
    { package: "@ada/notes", version: "1.2.0", description: "Notes in the terminal" },
  ]);
});

test("targets resolve in order: path, installed app, npm spec, git source, Server URL", async () => {
  const at = { directories, cwd: "/work" };
  expect(resolveTarget("./notes", at)).toEqual({ kind: "path", directory: "/work/notes" });
  expect(resolveTarget("/abs/notes", at)).toEqual({ kind: "path", directory: "/abs/notes" });
  expect(resolveTarget(".", at)).toEqual({ kind: "path", directory: "/work" });
  expect(resolveTarget("notes", at)).toEqual({
    kind: "npm",
    spec: { name: "notes", range: undefined },
  });
  expect(resolveTarget("github:ada/notes#v1", at)).toMatchObject({
    kind: "git",
    source: { url: "https://github.com/ada/notes.git", ref: "v1" },
  });
  expect(resolveTarget("https://notes.example.com", at)).toEqual({
    kind: "url",
    url: "https://notes.example.com",
  });
  // Without the sandbox mode and not chosen inline: refused before any request reaches
  // the Server. With it (macOS), sandboxed by default: the Server is asked for its manifest.
  const refusal = messageOf(
    await rejectionOf(launch("https://notes.example.com", { directories })),
  );
  if (sandboxSupported()) expect(refusal).not.toContain("--inline");
  else expect(refusal).toContain("airtty https://notes.example.com --inline");
  expect(() => resolveTarget("examples/notes", at)).toThrow("start it with ./");
});
