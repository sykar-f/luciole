import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { build } from "../packages/airtty/src/build";
import { compileClient, fetchRuntime, hostTarget } from "../packages/airtty/src/compile";
import { messageOf } from "../packages/airtty/src/guards";
import { rejectionOf } from "./helpers";

// A registry serving a fake runtime package, the way npm publishes @oven/bun-<os>-<arch>.
const name = (() => {
  const [, os, arch] = hostTarget().split("-");
  return `bun-${os}-${arch === "arm64" ? "aarch64" : arch}`;
})();
let work: string, tarball: Uint8Array, integrity: string, registry: ReturnType<typeof Bun.serve>;
const requests: string[] = [],
  caches: string[] = [];

beforeAll(async () => {
  work = await mkdtemp(join(tmpdir(), "airtty-runtime-"));
  await mkdir(join(work, "package/bin"), { recursive: true });
  await Bun.write(join(work, "package/bin/bun"), "#!/bin/sh\necho stock\n");
  Bun.spawnSync(["tar", "czf", "runtime.tgz", "package"], { cwd: work });
  tarball = await Bun.file(join(work, "runtime.tgz")).bytes();
  integrity = `sha512-${new Bun.CryptoHasher("sha512").update(tarball).digest("base64")}`;
  registry = Bun.serve({
    port: 0,
    fetch(request) {
      const { pathname } = new URL(request.url);
      requests.push(pathname);
      if (pathname === `/@oven/${name}/${Bun.version}`)
        return Response.json({ dist: { tarball: `${registry.url}runtime.tgz`, integrity } });
      if (pathname === "/runtime.tgz") return new Response(Bun.file(join(work, "runtime.tgz")));
      return new Response("not found", { status: 404 });
    },
  });
});
afterAll(async () => {
  await registry.stop(true);
  for (const dir of [work, ...caches]) await rm(dir, { recursive: true, force: true });
});

const source = async () => {
  const cache = await mkdtemp(join(tmpdir(), "airtty-cache-"));
  caches.push(cache);
  return { cache, registry: registry.url.href.replace(/\/$/, "") };
};

test("the stock runtime is verified, cached in one rename, then reused offline", async () => {
  const options = await source();
  requests.length = 0;
  const executable = await fetchRuntime(hostTarget(), options);
  expect(executable).toBe(join(options.cache, "runtime", `${name}-${Bun.version}/package/bin/bun`));
  expect(await Bun.file(executable).text()).toContain("stock");
  expect(requests).toEqual([`/@oven/${name}/${Bun.version}`, "/runtime.tgz"]);
  // No staging directory nor tarball stays in the cache.
  expect(await readdir(join(options.cache, "runtime"))).toEqual([`${name}-${Bun.version}`]);
  expect(await readdir(join(options.cache, "runtime", `${name}-${Bun.version}`))).toEqual([
    "package",
  ]);
  requests.length = 0;
  expect(await fetchRuntime(hostTarget(), { ...options, registry: "http://127.0.0.1:9" })).toBe(
    executable,
  );
  expect(requests).toEqual([]);
});

test("a tarball that does not match the published integrity is never cached", async () => {
  const options = await source();
  const genuine = integrity;
  integrity = `sha512-${new Bun.CryptoHasher("sha512").update("tampered").digest("base64")}`;
  try {
    expect(messageOf(await rejectionOf(fetchRuntime(hostTarget(), options)))).toContain(
      "does not match the integrity",
    );
  } finally {
    integrity = genuine;
  }
  expect(await readdir(join(options.cache, "runtime")).catch(() => [])).toEqual([]);
});

test("an incomplete entry left by an older cache is replaced", async () => {
  const options = await source();
  const stale = join(options.cache, "runtime", `${name}-${Bun.version}`);
  await Bun.write(join(stale, "runtime.tgz"), "partial");
  // Extracted in place and interrupted: a bun is there, but truncated.
  await Bun.write(join(stale, "package/bin/bun"), "trunc");
  const executable = await fetchRuntime(hostTarget(), options);
  expect(await Bun.file(executable).text()).toContain("stock");
  expect(await Bun.file(join(stale, "runtime.tgz")).exists()).toBe(false);
});

test("--compile embeds the stock runtime by default and explains an offline miss", async () => {
  const { output } = await build(resolve("examples/notes"));
  const offline = { cache: (await source()).cache, registry: "http://127.0.0.1:9" };
  expect(
    messageOf(await rejectionOf(compileClient(output, { name: "notes", ...offline }))),
  ).toContain("Connect once to cache it, or pass --runtime host");
  const foreign = hostTarget() === "bun-linux-x64" ? "bun-linux-arm64" : "bun-linux-x64";
  expect(
    messageOf(
      await rejectionOf(compileClient(output, { name: "notes", target: foreign, runtime: "host" })),
    ),
  ).toContain(`--runtime host only builds for ${hostTarget()}`);
  expect(
    messageOf(
      await rejectionOf(
        compileClient(output, { name: "notes", runtime: join(offline.cache, "missing-bun") }),
      ),
    ),
  ).toContain("not found");
}, 60000);
