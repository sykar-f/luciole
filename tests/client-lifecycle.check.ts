/** Real terminal restoration for each Client exit path, selected explicitly. */
import { expect, test } from "bun:test";
import { join } from "node:path";
import { constants } from "node:os";
import { ctrl, drive } from "../scripts/pty/driver";
import { BUN, build, startServer } from "../scripts/pty/harness";
import { privateExample } from "../scripts/web/private-example";

const TIMEOUT_MS = 240_000;
test(
  "Client exits await terminal restoration on quit, signals, crashes and output errors",
  async () => {
    using directory = privateExample("notes", "luciole-client-close-");
    await Bun.write(
      join(directory.app, "app/layout.tsx"),
      `
"use client";
import {useEffect} from "react";
import {useRenderer} from "@opentui/react";
import {useApplication} from "@luciole-sh/core/client";
export default function Layout() {
  const renderer = useRenderer();
  const app = useApplication();
  useEffect(() => {
    const close = () => {
      switch (process.env.CLOSURE_TEST_MODE) {
        case "quit": app.quit(); break;
        case "destroy": renderer.destroy(); break;
        case "exit": process.exit(3);
        case "throw": setImmediate(() => {throw new Error("closure test crash")}); break;
        case "reject": void Promise.reject(new Error("closure test rejection")); break;
        case "output-error": process.stdout.emit("error", new Error("closure test output failure")); break;
      }
    };
    process.on("SIGUSR1", close);
    return () => process.off("SIGUSR1", close);
  }, [renderer, app]);
  return <box flexDirection="column" flexGrow={1}><text height={1} flexShrink={0}>Closure test ready</text></box>;
}
`,
    );
    build(directory.app);
    await using server = await startServer(directory.app, {
      NOTES_DB: join(directory.path, "notes.sqlite"),
    });
    const signals: NodeJS.Signals[] = ["SIGINT", "SIGTERM", "SIGHUP", "SIGQUIT", "SIGABRT"];
    const exitCodes: Record<string, number> = {
      exit: 3,
      "output-error": 1,
      SIGQUIT: 131,
      SIGABRT: 134,
    };
    for (const signal of ["SIGBUS", "SIGBREAK"] as const) {
      const number = constants.signals[signal];
      if (number === undefined) continue;
      signals.push(signal);
      exitCodes[signal] = 128 + number;
    }
    for (const mode of [
      "ctrl-c",
      ...signals,
      "desktop-hup",
      "quit",
      "destroy",
      "exit",
      "throw",
      "reject",
      "output-error",
    ]) {
      await using terminal = await drive({
        command: [BUN, join(directory.app, ".luciole/client/index.js"), "--url", server.url],
        cols: 80,
        rows: 24,
        env: {
          NODE_ENV: "production",
          XDG_STATE_HOME: join(directory.path, mode),
          CLOSURE_TEST_MODE: mode,
          ...(mode === "desktop-hup" ? { LUCIOLE_DESKTOP: "1" } : {}),
        },
      });
      await terminal.waitFor("Closure test ready");
      const signal = signals.find((signal) => signal === mode);
      if (mode === "ctrl-c") terminal.write(ctrl("c"));
      else if (mode === "desktop-hup") terminal.signal("SIGHUP");
      else if (signal) terminal.signal(signal);
      else terminal.signal("SIGUSR1");
      if (mode === "throw" || mode === "reject") {
        await terminal.until(
          () =>
            terminal
              .output()
              .includes(mode === "throw" ? "closure test crash" : "closure test rejection"),
          "the non-fatal OpenTUI error",
        );
        expect(terminal.running).toBe(true);
        terminal.signal("SIGTERM");
      }
      expect(await terminal.exited(), mode).toBe(exitCodes[mode] ?? 0);
      terminal.assertRestored();
      // A failed sink cannot carry ANSI resets, but raw mode still restores above.
      if (mode !== "output-error")
        expect(terminal.output().split("\x1b[?1049l"), mode).toHaveLength(2);
    }
  },
  TIMEOUT_MS,
);
