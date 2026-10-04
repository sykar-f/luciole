import { test, expect, spyOn } from "bun:test";
import { existsSync, lstatSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { loadAppBundle } from "../packages/core/src/app-bundle";
import { build } from "../packages/core/src/build";
import { messageOf } from "../packages/core/src/guards";
import { urlArgs } from "../packages/core/src/generic/launch";
import {
  originDirectory,
  originOf,
  originSessions,
  pinPublisher,
  readOrigin,
} from "../packages/core/src/generic/origin";
import { INLINE_WARNING, prepareOrigin } from "../packages/core/src/generic/prepare";
import { Capabilities } from "../packages/core/src/capabilities";
import { directories } from "../packages/core/src/launcher/paths";
import {
  generatePublisherKey,
  publisherIdentity,
  readPublisherKey,
} from "../packages/core/src/publisher";
import { launch, privateBuild, rejectionOf } from "./helpers";

test("an origin is the URL the user gave, normalized", () => {
  expect(originOf("http://127.0.0.1:4000/some/path?q=1")).toBe("http://127.0.0.1:4000");
  expect(originOf("https://Notes.Example.com/")).toBe("https://notes.example.com");
  expect(originOf("ssh://ada@Host.example:2222/run/notes.sock")).toBe(
    "ssh://ada@host.example:2222/run/notes.sock",
  );
  expect(() => originOf("unix:/tmp/x.sock")).toThrow("http(s):// or ssh://");
  expect(originSessions("http://a")).toMatch(/^origins\/[0-9a-f]{64}$/);
});

test("a URL launch takes more URLs as tabs, a mode and --allow-* flags, nothing else", () => {
  expect(urlArgs("http://a", ["--inline", "https://b"])).toEqual({
    urls: ["http://a", "https://b"],
    mode: "inline",
    allow: Capabilities.parse({}),
  });
  const { mode, allow } = urlArgs(
    "http://a",
    [
      "--sandbox",
      "--allow-read=/data,docs",
      "--allow-net=api.example.com",
      "--allow-clipboard-write",
    ],
    "/home/ada",
  );
  expect(mode).toBe("sandbox");
  expect(allow.fs.read).toEqual(["/data", "/home/ada/docs"]);
  expect(allow.net).toEqual(["api.example.com"]);
  expect(allow.clipboard).toEqual({ read: false, write: true });
  expect(() => urlArgs("http://a", ["--inline", "--sandbox"])).toThrow("exclude each other");
  expect(() => urlArgs("http://a", ["--allow-everything"])).toThrow("--allow-read");
  expect(() => urlArgs("http://a", ["--allow-net=not a host"])).toThrow();
  expect(() => urlArgs("http://a", ["--url", "x"])).toThrow("--inline");
});

const latency = resolve("examples/latency");
const built = await privateBuild("examples/latency");
async function temporary(prefix: string) {
  return mkdtemp(join(tmpdir(), prefix));
}

test("prepareOrigin without a sandbox: signature, first-use pin, explicit inline, cache, changed key", async () => {
  const home = await temporary("luciole-generic-");
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: home,
    XDG_CONFIG_HOME: join(home, "config"),
    XDG_STATE_HOME: join(home, "state"),
    XDG_CACHE_HOME: join(home, "cache"),
  };
  const dirs = directories(env);
  const logs: string[] = [];
  const questions: string[] = [];
  let answer = true;
  // `sandbox: false`: what a system without the sandbox mode does (Linux until step 8).
  const options = (inline: boolean) => ({
    mode: inline ? ("inline" as const) : undefined,
    sandbox: { mechanism: undefined, reason: "none in this test" },
    directories: dirs,
    env,
    log: (m: string) => void logs.push(m),
    confirm: (q: string) => {
      questions.push(q);
      return Promise.resolve(answer);
    },
  });
  const buildSigned = async (keysHome: string) => {
    const keyEnv = { ...env, XDG_CONFIG_HOME: keysHome };
    if (!existsSync(join(keysHome, "luciole/keys/publisher.pem"))) generatePublisherKey(keyEnv);
    const key = readPublisherKey(keyEnv);
    await build(latency, built.output, { signBundle: key });
    return publisherIdentity(key).fingerprint;
  };
  const server = join(built.output, "server/index.js");
  let running = await launch(server);
  try {
    // Restarted on its port: one origin across rebuilds, as a deployed Server keeps its URL.
    const port = String(running.port);
    const restart = async () => {
      await running.stop();
      running = await launch(server, { PORT: port });
    };
    const fingerprint = await buildSigned(join(home, "publisher-a"));
    await restart();
    const url = running.url;
    const origin = originOf(url);

    // Nothing opens without the user choosing inline where the sandbox does not exist.
    expect(messageOf(await rejectionOf(prepareOrigin(url, options(false))))).toContain(
      `luciole ${url} --inline`,
    );
    // Declined at the first-use question: nothing pinned.
    answer = false;
    expect(messageOf(await rejectionOf(prepareOrigin(url, options(true))))).toContain("not opened");
    expect(readOrigin(origin, env)).toBeUndefined();

    answer = true;
    const bundleRequests = () =>
      fetchSpy.mock.calls.filter(([input]) =>
        (input instanceof Request ? input.url : input.toString()).includes("/bundle/"),
      ).length;
    const fetchSpy = spyOn(globalThis, "fetch");
    try {
      const prepared = await prepareOrigin(url, options(true));
      expect(questions.at(-1)).toContain(`trust publisher key ${fingerprint}`);
      expect(logs.join("\n")).toContain(INLINE_WARNING);
      expect(logs.join("\n")).toContain("Capacités déclarées (non appliquées) : aucune");
      const record = readOrigin(origin, env);
      expect(record?.publisher?.fingerprint).toBe(fingerprint);
      expect(record?.mode).toBe("inline");
      expect(prepared.app).toBe(join(originDirectory(origin, env), "app"));
      expect(lstatSync(join(prepared.app, "index.cjs")).isSymbolicLink()).toBe(true);
      const loaded = await loadAppBundle(prepared.app, {
        publisher: {
          required: true,
          trust: (f) => {
            expect(f).toBe(fingerprint);
          },
        },
      });
      expect(loaded.manifest.name).toBe("latency");
      expect(bundleRequests()).toBe(1);

      // Remembered: no flag, no question, and the bundle comes from the cache.
      const asked = questions.length;
      await prepareOrigin(url, options(false));
      expect(questions.length).toBe(asked);
      expect(bundleRequests()).toBe(1);
    } finally {
      fetchSpy.mockRestore();
    }

    // Another key for the same origin: refused, with the out-of-band way to accept it.
    const rotated = await buildSigned(join(home, "publisher-b"));
    await restart();
    const refused = messageOf(await rejectionOf(prepareOrigin(url, options(true))));
    expect(refused).toContain("publisher key changed");
    expect(refused).toContain(`luciole trust ${origin} ${rotated}`);
    pinPublisher(origin, rotated, env);
    await prepareOrigin(url, options(false));
    expect(readOrigin(origin, env)?.publisher?.fingerprint).toBe(rotated);
    expect(() => pinPublisher(origin, "not-a-fingerprint", env)).toThrow("SHA256");

    // An unsigned bundle is never opened by URL.
    await build(latency, built.output);
    await restart();
    expect(messageOf(await rejectionOf(prepareOrigin(url, options(true))))).toContain(
      "not signed by its publisher",
    );
  } finally {
    await running.stop();
    await rm(home, { recursive: true, force: true });
  }
}, 120_000);
