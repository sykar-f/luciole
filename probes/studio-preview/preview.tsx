/** @jsxImportSource @opentui/react */
/**
 * studio's preview, in `process` mode: a generated app run by `luciole dev` on a PTY,
 * shown by `<Terminal>` inside a host tree, while the files it is built from change
 * under it as a harness would change them. Measures the cold start, the reload after an
 * edit, and what the preview shows when the build fails, when a render throws and when
 * the app's Client dies. Run from the repository root: `bun probes/studio-preview/preview.tsx`
 * (writes results.json next to it; exit 1 when an assertion fails).
 */
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { act, useState, type ReactNode } from "react";
import { useRenderer } from "@opentui/react";
import { testRender } from "@opentui/react/test-utils";
import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui";
import { KeymapProvider } from "@opentui/keymap/react";
import { Terminal } from "../../packages/luciole/src/client";
import { spawnPty } from "../../packages/luciole/src/vt/pty";
import { TerminalView } from "../../packages/luciole/src/vt/terminal";
import { destroy, until, type TestUI } from "../../tests/helpers";

const HERE = import.meta.dir;
const CLI = resolve(HERE, "../../packages/luciole/src/cli.ts");
const TEMPLATE = join(HERE, "template");
// Ignored by git (`.luciole-*/`) and by tsc (a dot directory under probes/).
const WORK = join(HERE, ".luciole-work");
const WIDTH = 100;
const HEIGHT = 24;
const COLD_TIMEOUT_MS = 30_000;
const STEP_TIMEOUT_MS = 20_000;
const EXIT_TIMEOUT_MS = 10_000;
// Long enough for a rebuild that would wrongly happen to show.
const QUIET_MS = 1500;
const REPEATS = 5;
const DECIMALS = 10;

const results: Record<string, unknown> = {
  date: new Date().toISOString(),
  platform: `${process.platform} ${process.arch}`,
  bun: Bun.version,
};
const failures: string[] = [];
function check(name: string, ok: boolean, detail?: unknown) {
  results[name] = detail === undefined ? ok : { ok, detail };
  if (!ok) failures.push(name);
  console.log(
    `${ok ? "ok  " : "FAIL"} ${name}${detail === undefined ? "" : ` ${JSON.stringify(detail)}`}`,
  );
}
const ms = (start: number) => Math.round((performance.now() - start) * DECIMALS) / DECIMALS;
const median = (values: readonly number[]) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? Number.NaN;
};

/** A fresh copy of the template: what studio hands the harness for a new session. */
function workspace(name: string) {
  const directory = join(WORK, name);
  rmSync(directory, { recursive: true, force: true });
  mkdirSync(WORK, { recursive: true });
  cpSync(TEMPLATE, directory, { recursive: true });
  return directory;
}

/** The keymap a Shell provides: `<Terminal>` needs one to intercept keys. */
function Host({ children }: { children: ReactNode }) {
  const renderer = useRenderer();
  const [keymap] = useState(() => createDefaultOpenTuiKeymap(renderer));
  return <KeymapProvider keymap={keymap}>{children}</KeymapProvider>;
}

type Preview = {
  frame(): string;
  shows(text: string, timeout?: number): Promise<number>;
  gone(text: string, timeout?: number): Promise<number>;
  press(key: string): Promise<void>;
  exits: (number | null)[];
  close(): Promise<void>;
};
/**
 * `hangup`: `<Terminal>` as it is, which ends its program with SIGHUP when it unmounts;
 * `terminate`: the same widget (TerminalView) whose program is ended with SIGTERM.
 */
async function preview(
  directory: string,
  end: "hangup" | "terminate" = "hangup",
): Promise<Preview> {
  const exits: (number | null)[] = [];
  const command = [process.execPath, CLI, "dev", "--app", directory];
  const ui: TestUI = await testRender(
    <Host>
      <box flexGrow={1}>
        {end === "hangup" ? (
          <Terminal
            command={command}
            active
            prefix="ctrl+o"
            flexGrow={1}
            onExit={(code) => exits.push(code)}
          />
        ) : (
          <TerminalView
            program={JSON.stringify(command)}
            label="luciole dev"
            spawn={(io) => {
              const pty = spawnPty({ ...io, command });
              return { ...pty, kill: () => process.kill(pty.pid, "SIGTERM") };
            }}
            active
            prefix="ctrl+o"
            flexGrow={1}
            onExit={(code) => exits.push(code)}
          />
        )}
      </box>
    </Host>,
    { width: WIDTH, height: HEIGHT },
  );
  const frame = () => {
    void ui.renderOnce();
    return ui.captureCharFrame();
  };
  const waitFor = async (predicate: () => boolean, timeout: number) => {
    const start = performance.now();
    await act(async () => {
      await until(predicate, timeout);
    });
    return ms(start);
  };
  return {
    frame,
    exits,
    shows: (text, timeout = STEP_TIMEOUT_MS) => waitFor(() => frame().includes(text), timeout),
    gone: (text, timeout = STEP_TIMEOUT_MS) => waitFor(() => !frame().includes(text), timeout),
    press: (key) =>
      act(async () => {
        ui.mockInput.pressKey(key);
      }),
    close: () => destroy(ui),
  };
}

const edit = (directory: string, file: string, change: (text: string) => string) => {
  const path = join(directory, file);
  writeFileSync(path, change(readFileSync(path, "utf8")));
};
const firstLines = (frame: string, count: number) =>
  frame
    .split("\n")
    .map((line) => line.trimEnd())
    .filter(Boolean)
    .slice(0, count);
const FRAME_LINES = 6;

// ---------------------------------------------------------------------------------------
// Scenario 1: start, interact, edit, break the build, repair, throw in a render, crash.
{
  const directory = workspace("reload");
  const started = performance.now();
  const view = await preview(directory);
  try {
    await view.shows("studio preview v1", COLD_TIMEOUT_MS);
    check("cold start: first frame of the generated app", true, { ms: ms(started) });

    // The generated app's own keys reach it through the widget, its action its Server.
    await view.press("+");
    await view.shows("Count: 1");
    check("the preview is interactive (key → Server Function → render)", true);

    // What a harness edit costs until it is on screen: server code, then client code.
    const serverReloads: number[] = [];
    for (let i = 2; i < 2 + REPEATS; i++) {
      const start = performance.now();
      edit(
        directory,
        "server/greeting.ts",
        () => `export const greeting = "studio preview v${i}";\n`,
      );
      await view.shows(`studio preview v${i}`);
      serverReloads.push(ms(start));
    }
    check("reload after a server file edit (debounce + build + restart)", true, {
      medianMs: median(serverReloads),
      samplesMs: serverReloads,
    });
    // A rebuild restarts the generated app's Server: its memory is gone.
    check("in-memory Server state is lost on reload", view.frame().includes("Count: 0"));

    const clientReloads: number[] = [];
    for (let i = 0; i < REPEATS; i++) {
      const start = performance.now();
      const label = `(press + to increment, edit ${i})`;
      edit(directory, "components/Counter.tsx", (text) =>
        text.replace(/\(press \+ to increment[^)]*\)/, label),
      );
      await view.shows(label);
      clientReloads.push(ms(start));
    }
    check("reload after a client component edit", true, {
      medianMs: median(clientReloads),
      samplesMs: clientReloads,
    });

    // A syntax error: the last good screen stays, the error is shown over it (template
    // chrome reading useConnection().buildError).
    const goodCounter = readFileSync(join(directory, "components/Counter.tsx"), "utf8");
    let start = performance.now();
    edit(directory, "components/Counter.tsx", (text) =>
      text.replace("return <text", "return <text <"),
    );
    await view.shows("Build failed");
    const broken = view.frame();
    check("build error shown over the last good screen", broken.includes("studio preview v"), {
      ms: ms(start),
      frame: firstLines(broken, FRAME_LINES),
    });
    start = performance.now();
    writeFileSync(join(directory, "components/Counter.tsx"), goodCounter);
    await view.gone("Build failed");
    check("repair clears the build error (fresh Client)", true, { ms: ms(start) });

    // A render that throws on the Server: what the preview shows.
    const goodPage = readFileSync(join(directory, "app/page.tsx"), "utf8");
    start = performance.now();
    edit(directory, "app/page.tsx", (text) =>
      text.replace(
        "export default function Page() {",
        'export default function Page() {\n  if (Date.now() > 0) throw new Error("generated page failed");',
      ),
    );
    await view.shows("generated page failed");
    check("Server render error reaches the preview", true, {
      ms: ms(start),
      frame: firstLines(view.frame(), FRAME_LINES),
    });
    writeFileSync(join(directory, "app/page.tsx"), goodPage);
    await view.shows("studio preview v");

    // A client component that throws while rendering.
    start = performance.now();
    edit(directory, "components/Counter.tsx", (text) =>
      text.replace(
        "const [value, setValue]",
        'if (Date.now() > 0) throw new Error("generated component failed");\n  const [value, setValue]',
      ),
    );
    await view.shows("generated component failed");
    check("Client render error reaches the preview", true, {
      ms: ms(start),
      frame: firstLines(view.frame(), FRAME_LINES),
      devStillRunning: view.exits.length === 0,
    });
    writeFileSync(join(directory, "components/Counter.tsx"), goodCounter);
    await view.shows("Count: 0");
    check("repair after a Client render error", true);

    // The generated Client exits by itself: `luciole dev` stops with it, the PTY program
    // ends, the host is told (studio must restart the preview itself).
    start = performance.now();
    edit(directory, "components/Counter.tsx", (text) =>
      text
        .replace(
          'import { useState } from "react";',
          'import { useEffect, useState } from "react";',
        )
        .replace(
          "const [value, setValue]",
          "useEffect(() => process.exit(3), []);\n  const [value, setValue]",
        ),
    );
    await act(async () => {
      await until(() => view.exits.length > 0, EXIT_TIMEOUT_MS);
    });
    check("a dying generated Client ends luciole dev (host sees onExit)", true, {
      ms: ms(start),
      code: view.exits[0],
    });
  } catch (error: unknown) {
    check("scenario 1 completed", false, { error: String(error), frame: view.frame() });
  } finally {
    await view.close();
  }
}

// ---------------------------------------------------------------------------------------
// Scenario 2: the very first build fails (a harness's first attempt), then is repaired.
{
  const directory = workspace("first-failure");
  edit(directory, "app/page.tsx", (text) => text.replace("<box", "<box <"));
  const view = await preview(directory);
  try {
    await view.shows("Build failed", COLD_TIMEOUT_MS);
    check("first build failure: shown as text in the PTY (no Client yet)", true, {
      frame: firstLines(view.frame(), FRAME_LINES),
    });
    await Bun.sleep(QUIET_MS);
    check("luciole dev keeps waiting after a failed first build", view.exits.length === 0);
    const start = performance.now();
    cpSync(join(TEMPLATE, "app/page.tsx"), join(directory, "app/page.tsx"));
    await view.shows("studio preview v1");
    check("repair of a failed first build starts the Client", true, { ms: ms(start) });
    // package.json is not watched: a dependency or capability change needs a restart.
    edit(directory, "package.json", (text) => text.replace('"studio app"', '"studio app 2"'));
    await Bun.sleep(QUIET_MS);
    check("package.json edits do not trigger a rebuild", !view.frame().includes("Build failed"));
  } catch (error: unknown) {
    check("scenario 2 completed", false, { error: String(error), frame: view.frame() });
  } finally {
    await view.close();
  }
}

const leftovers = (name: string) =>
  spawnSync("pgrep", ["-f", join(WORK, name)], { encoding: "utf8" })
    .stdout.split("\n")
    .filter(Boolean)
    .map(Number);
// Closing <Terminal> sends SIGHUP to `luciole dev`, which only handles SIGINT and SIGTERM:
// it dies without stopping the generated Server and Client it started.
await Bun.sleep(QUIET_MS);
const orphans = leftovers("first-failure");
check("closing <Terminal> (SIGHUP) orphans the generated Server and Client", orphans.length > 0, {
  orphans: orphans.length,
});
for (const pid of orphans) process.kill(pid, "SIGTERM");

// ---------------------------------------------------------------------------------------
// Scenario 3: the same preview ended with SIGTERM, which `luciole dev` handles.
{
  const directory = workspace("terminate");
  const view = await preview(directory, "terminate");
  try {
    await view.shows("studio preview v1", COLD_TIMEOUT_MS);
  } catch (error: unknown) {
    check("scenario 3 completed", false, { error: String(error), frame: view.frame() });
  } finally {
    await view.close();
  }
  await Bun.sleep(QUIET_MS);
  const left = leftovers("terminate");
  check("closing with SIGTERM leaves no process behind", left.length === 0, { left: left.length });
  for (const pid of left) process.kill(pid, "SIGTERM");
}

writeFileSync(join(HERE, "results.json"), JSON.stringify(results, null, 2) + "\n");
console.log(failures.length ? `${failures.length} failed` : "all passed");
process.exit(failures.length ? 1 : 0);
