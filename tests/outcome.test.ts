import { afterAll, beforeAll, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { build } from "../src/build";
import {
  createHttpTransport,
  networkFromEnv,
  TransportError,
  type Outcome,
} from "../src/transport";
import { launch, until } from "./helpers";

// Each outcome is checked against a real Notes Server and its database: `not-sent` and
// `rejected` must mean the save never ran, `unknown` that it may have.
const root = resolve("examples/notes");
let dir = "",
  buildId = "";
beforeAll(async () => {
  ({ buildId } = await build(root));
  dir = await mkdtemp(join(tmpdir(), "airtty-outcome-"));
});
afterAll(() => rm(dir, { recursive: true, force: true }));

const server = (name: string, env: Record<string, string> = {}) =>
  launch(join(root, ".airtty/server/index.js"), { NOTES_DB: join(dir, `${name}.sqlite`), ...env });
const transport = (url: string, options: { buildId?: string; token?: string } = {}) =>
  createHttpTransport({
    url,
    buildId: options.buildId ?? buildId,
    token: options.token,
    callServer: () => Promise.reject(new Error("unused")),
  });
const save = (value = "saved") => [
  { id: "1", value, version: 1, revision: 1, operationId: crypto.randomUUID() },
];
const saveNote = () => `${buildId}/actions/notes.ts#saveNote`;
async function outcomeOf(work: Promise<unknown>): Promise<Outcome> {
  const error = await work.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(TransportError);
  return (error as TransportError).outcome;
}
const stored = (name: string) => {
  const db = new Database(join(dir, `${name}.sqlite`), { readonly: true });
  try {
    return (db.query("SELECT value FROM notes WHERE id='1'").get() as { value: string }).value;
  } finally {
    db.close();
  }
};

test("a stopped Server: not-sent", async () => {
  const s = await server("stopped");
  await s.stop();
  expect(await outcomeOf(transport(s.url).call(saveNote(), save()))).toBe("not-sent");
  expect(stored("stopped")).toBe("");
});

test("refused before any application code: rejected", async () => {
  const s = await server("rejected", { AIRTTY_TOKEN: "secret" });
  try {
    // Missing bearer, other build, unknown action, malformed arguments.
    expect(await outcomeOf(transport(s.url).call(saveNote(), save()))).toBe("rejected");
    expect(
      await outcomeOf(
        transport(s.url, { buildId: "other", token: "secret" }).call(saveNote(), save()),
      ),
    ).toBe("rejected");
    expect(
      await outcomeOf(transport(s.url, { token: "secret" }).call(`${buildId}/x.ts#nope`, [])),
    ).toBe("rejected");
    expect(stored("rejected")).toBe("");
    // The same bearer and build succeed: the refusals were not transient.
    const ok = (await transport(s.url, { token: "secret" }).call(saveNote(), save())) as {
      ok: boolean;
    };
    expect(ok.ok).toBe(true);
    expect(stored("rejected")).toBe("saved");
  } finally {
    await s.stop();
  }
});

test("the Server commits then the response is lost: unknown", async () => {
  const s = await server("lost", { AIRTTY_TEST_DROP_ONCE: "1" });
  try {
    expect(await outcomeOf(transport(s.url).call(saveNote(), save("committed")))).toBe("unknown");
    await until(() => s.child.exitCode !== null);
    expect(stored("lost")).toBe("committed");
  } finally {
    await s.stop();
  }
});

test("application code throws: unknown, the Server may have written before", async () => {
  const s = await server("thrown");
  try {
    const invalid = [{ id: "1", value: "x", version: 1, revision: 1, operationId: "bad" }];
    expect(await outcomeOf(transport(s.url).call(saveNote(), invalid))).toBe("unknown");
  } finally {
    await s.stop();
  }
});

test("a request cancelled before it is sent: not-sent", async () => {
  const s = await server("cancelled");
  try {
    const controller = new AbortController();
    controller.abort();
    expect(await outcomeOf(transport(s.url).call(saveNote(), save(), controller.signal))).toBe(
      "not-sent",
    );
    expect(stored("cancelled")).toBe("");
  } finally {
    await s.stop();
  }
});

// Simulated faults must produce the outcome their real counterpart would, with the same
// effect on the Server: a regression test for the classification itself.
test("simulated faults: refuse, drop and cut", async () => {
  const s = await server("faults");
  const faulty = (fault: "refuse" | "drop" | "cut") =>
    createHttpTransport({
      url: s.url,
      buildId,
      callServer: () => Promise.reject(new Error("unused")),
      network: { fault: () => fault },
    });
  try {
    expect(await outcomeOf(faulty("refuse").call(saveNote(), save("refused")))).toBe("not-sent");
    expect(stored("faults")).toBe("");
    expect(await outcomeOf(faulty("drop").call(saveNote(), save("dropped")))).toBe("unknown");
    expect(stored("faults")).toBe("dropped");
    const cut = [
      { id: "1", value: "cut", version: 2, revision: 1, operationId: crypto.randomUUID() },
    ];
    expect(await outcomeOf(faulty("cut").call(saveNote(), cut))).toBe("unknown");
    expect(stored("faults")).toBe("cut");
  } finally {
    await s.stop();
  }
});

test("slow chunks and jitter delay delivery; conditions are validated", async () => {
  const s = await server("slow");
  try {
    const slow = createHttpTransport({
      url: s.url,
      buildId,
      callServer: () => Promise.reject(new Error("unused")),
      network: { chunkDelayMs: 60, jitterMs: 20 },
    });
    const start = performance.now();
    await slow.render("/", {}, new AbortController().signal);
    expect(performance.now() - start).toBeGreaterThanOrEqual(60);
    for (const network of [{ jitterMs: -1 }, { chunkDelayMs: NaN }])
      expect(() =>
        createHttpTransport({ url: s.url, buildId, callServer: async () => 0, network }),
      ).toThrow("must be a finite non-negative number");
  } finally {
    await s.stop();
  }
});

test("AIRTTY_FAULT and friends parse into network conditions", () => {
  const always = networkFromEnv({ AIRTTY_FAULT: "drop:1", AIRTTY_JITTER_MS: "5" });
  expect(always.jitterMs).toBe(5);
  expect(always.fault?.({ kind: "action", target: "x" })).toBe("drop");
  expect(networkFromEnv({}).fault).toBeUndefined();
  expect(
    networkFromEnv({ AIRTTY_FAULT: "refuse:0" }).fault?.({ kind: "render", target: "/" }),
  ).toBe(undefined);
  for (const bad of ["explode:1", "drop:2", "drop:x"])
    expect(() => networkFromEnv({ AIRTTY_FAULT: bad })).toThrow("AIRTTY_FAULT");
  expect(() => networkFromEnv({ AIRTTY_CHUNK_DELAY_MS: "-3" })).toThrow("AIRTTY_CHUNK_DELAY_MS");
});
