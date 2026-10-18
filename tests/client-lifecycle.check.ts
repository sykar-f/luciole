/** Real terminal restoration for each Client exit path, selected explicitly. */
import { expect, test } from "bun:test";
import { join } from "node:path";
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
export default function Layout({children}) {
  const renderer = useRenderer();
  const app = useApplication();
  useEffect(() => {
    const close = () => {
      switch (process.env.CLOSURE_TEST_MODE) {
        case "quit": app.quit(); break;
        case "destroy": renderer.destroy(); break;
        case "throw": setImmediate(() => {throw new Error("closure test crash")}); break;
        case "reject": void Promise.reject(new Error("closure test rejection")); break;
        case "output-error": process.stdout.emit("error", new Error("closure test output failure")); break;
      }
    };
    process.on("SIGUSR1", close);
    return () => process.off("SIGUSR1", close);
  }, [renderer, app]);
  return <box flexDirection="column"><text>Closure test ready</text>{children}</box>;
}
`,
    );
    build(directory.app);
    await using server = await startServer(directory.app, {
      NOTES_DB: join(directory.path, "notes.sqlite"),
    });
    for (const mode of [
      "ctrl-c",
      "SIGINT",
      "SIGTERM",
      "SIGHUP",
      "desktop-hup",
      "quit",
      "destroy",
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
      if (mode === "ctrl-c") terminal.write(ctrl("c"));
      else if (mode === "desktop-hup") terminal.signal("SIGHUP");
      else if (mode === "SIGINT" || mode === "SIGTERM" || mode === "SIGHUP") terminal.signal(mode);
      else terminal.signal("SIGUSR1");
      expect(await terminal.exited(), mode).toBe(
        ["throw", "reject", "output-error"].includes(mode) ? 1 : 0,
      );
      terminal.assertRestored();
      expect(terminal.output(), mode).toContain("\x1b[?1049l");
    }
  },
  TIMEOUT_MS,
);
