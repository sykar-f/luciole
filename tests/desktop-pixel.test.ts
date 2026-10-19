import { expect, test } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { until } from "./helpers";
import { decode, encode, type PixelOperation } from "../packages/core/src/pixel-scroll/protocol";

async function launch(mode: string, desktop = true, prepared = false, pixelFlag?: string) {
  const directory = await mkdtemp(join(process.env.TMPDIR ?? "/tmp", "desktop-pixel-"));
  let output = "";
  const events: unknown[] = [];
  const child = Bun.spawn([process.execPath, "tests/desktop-pixel-client.ts"], {
    env: {
      ...process.env,
      LUCIOLE_DESKTOP: desktop ? "1" : undefined,
      LUCIOLE_PIXEL_SCROLL: pixelFlag,
      LUCIOLE_SESSION: undefined,
      LUCIOLE_DEVTOOLS: undefined,
      XDG_STATE_HOME: directory,
      DESKTOP_PIXEL_CASE: mode,
      DESKTOP_PIXEL_CORE: prepared ? process.env.LUCIOLE_DESKTOP_PIXEL_CORE : undefined,
    },
    terminal: {
      cols: 40,
      rows: 10,
      data(_terminal, data) {
        output += Buffer.from(data).toString();
      },
    },
    stderr: "pipe",
    ipc(message: unknown) {
      events.push(message);
    },
  });
  const errors = new Response(child.stderr).text();
  return {
    child,
    events,
    directory,
    errors,
    output: () => output,
    wait: (condition: () => boolean) =>
      until(() => {
        if (child.exitCode !== null) throw new Error(`Client exited ${child.exitCode}: ${output}`);
        return condition();
      }),
    async close() {
      if (child.exitCode === null) child.kill("SIGKILL");
      await child.exited;
      child.terminal?.close();
    },
  };
}

for (const mode of [
  "stock",
  "disabled",
  "plain",
  "missing-writer",
  "missing-observer",
  "missing-frame",
  "attached",
  "reject",
]) {
  test(`desktop pixel attachment: ${mode}`, async () => {
    const f = await launch(mode, mode !== "plain");
    try {
      if (mode === "reject") {
        expect(await f.child.exited).toBe(1);
        const errors = (await f.errors) + f.output();
        expect(f.events).toContainEqual({ failure: "desktop control write rejected" });
        expect(errors).not.toContain("Unhandled");
      } else {
        await until(() => {
          if (f.child.exitCode !== null)
            throw new Error(`Client exited ${f.child.exitCode}: ${f.output()}`);
          return f.events.some((event) => JSON.stringify(event) === '{"ready":true}');
        });
        expect(f.events.some((event) => JSON.stringify(event) === '{"attached":true}')).toBe(
          mode === "attached",
        );
        if (mode === "stock") {
          await until(() => f.output().includes("Desktop row"));
          f.child.terminal?.write("\x1b[<65;3;3M");
          await until(() =>
            f.events.some(
              (event) =>
                typeof event === "object" &&
                event !== null &&
                "rowScroll" in event &&
                typeof event.rowScroll === "number" &&
                event.rowScroll > 0,
            ),
          );
          expect(operations(f.output())).toHaveLength(0);
        }
        f.child.send({ quit: true });
        expect(await f.child.exited, await f.errors).toBe(0);
      }
      expect(f.events).toContainEqual({
        destroyed: true,
        detached: mode === "attached" || mode === "reject",
        observed: 0,
      });
    } finally {
      await f.close();
    }
  }, 15_000);
}

function operations(wire: string): PixelOperation[] {
  // eslint-disable-next-line no-control-regex -- Parse terminal OSC controls in the captured PTY stream.
  return Array.from(wire.matchAll(/\x1b\]19462;luciole-pixel;[^\x1b]*\x1b\\/g), (match) =>
    decode(match[0]),
  ).filter(
    (op): op is PixelOperation =>
      op !== undefined &&
      ["query", "begin", "register", "step", "commit", "release"].includes(op.op),
  );
}

// An absolute matching JS/native entry prepared from the shared pixel patch.
// This selected integration never substitutes seams or changes the installed npm package.
test.skipIf(!process.env.LUCIOLE_DESKTOP_PIXEL_CORE)(
  "desktop patched runtime negotiates v2 and presents a fraction over a PTY",
  async () => {
    const f = await launch("patched", true, true);
    try {
      await f.wait(() =>
        operations(f.output()).some((op) => op.op === "query" && op.version === 2),
      );
      const query = operations(f.output()).find((op) => op.op === "query" && op.version === 2);
      if (query?.op !== "query") throw new Error("Missing query");
      const capability = encode({
        op: "capability",
        version: 2,
        nonce: query.nonce,
        snapshot: true,
        precise: true,
        reason: "ready",
      });
      f.child.terminal?.write(capability);
      await f.wait(() => operations(f.output()).some((op) => op.op === "commit"));
      const registration = operations(f.output()).findLast((op) => op.op === "register");
      if (registration?.op !== "register") throw new Error("Missing registration");
      f.child.terminal?.write(
        encode({
          op: "presented",
          version: 2,
          id: registration.id,
          generation: registration.generation,
        }),
      );
      f.child.terminal?.write(
        encode({
          op: "wheel",
          version: 1,
          id: registration.id,
          generation: registration.generation,
          x: 2,
          y: 2,
          phase: 0,
          modifiers: 0,
          dx: 0,
          dy: 0.35,
          source: "precise",
        }),
      );
      await f.wait(() =>
        operations(f.output()).some(
          (op) => op.op === "step" && Math.abs(op.fraction - 0.35) < 1e-6,
        ),
      );
      const ops = operations(f.output());
      const step = ops.find((op) => op.op === "step" && op.fraction > 0);
      if (step?.op !== "step") throw new Error("Missing fraction");
      expect(
        ops
          .filter((op) => op.op !== "query" && op.generation === step.generation)
          .map((op) => op.op),
      ).toEqual(["begin", "register", "step", "commit"]);
      // Ordinary mouse input reaches the patch observer before ordinary dispatch.
      f.child.terminal?.write("\x1b[<65;3;3M");
      await f.wait(() => f.events.some((event) => JSON.stringify(event) === '{"observed":true}'));
      f.child.send({ quit: true });
      expect(await f.child.exited, await f.errors).toBe(0);
      expect(f.events).toContainEqual({ destroyed: true, detached: true, observed: 1 });
      const trace = process.env.LUCIOLE_DESKTOP_PIXEL_TRACE ?? join(f.directory, "pty-trace.json");
      await writeFile(
        trace,
        JSON.stringify(
          { capability, output: f.output(), operations: ops, events: f.events },
          null,
          2,
        ),
      );
      console.log(`desktop v2 PTY fraction ${step.fraction}: ${trace}`);
    } finally {
      await f.close();
    }
  },
  20_000,
);

for (const [mode, flag, attached] of [
  ["launch-default", undefined, false],
  ["launch-enabled", "1", true],
  ["launch-other", "true", false],
  ["disabled", "1", false],
  ["attached", "0", true],
] as const) {
  test(`native pixel precedence: ${mode}, environment ${flag ?? "absent"}`, async () => {
    const f = await launch(mode, true, false, flag);
    try {
      await f.wait(() => f.events.some((event) => JSON.stringify(event) === '{"ready":true}'));
      expect(f.events.some((event) => JSON.stringify(event) === '{"attached":true}')).toBe(
        attached,
      );
      if (!attached) {
        await f.wait(() => f.output().includes("Desktop row"));
        f.child.terminal?.write("\x1b[<65;3;3M");
        await f.wait(() =>
          f.events.some(
            (event) =>
              typeof event === "object" &&
              event !== null &&
              "rowScroll" in event &&
              Number(event.rowScroll) > 0,
          ),
        );
        expect(operations(f.output())).toHaveLength(0);
      }
      f.child.send({ quit: true });
      expect(await f.child.exited, await f.errors).toBe(0);
    } finally {
      await f.close();
    }
  }, 15_000);
}
