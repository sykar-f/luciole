/**
 * `luciole` without arguments on a PTY: the launcher app lists an installed app, launches it
 * with the terminal to itself, comes back with its exit status, reports a target that
 * cannot launch and an unreachable registry, then quits cleanly. Offline.
 */
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { drive, Keys } from "./driver";
import { BUN, CLI, report, temporaryDirectory } from "./harness";

const FOCUS_MS = 300;
const UNREACHABLE = "http://127.0.0.1:1";

using directory = temporaryDirectory("luciole-pty-launcher-");
const base = directory.path;
// An installed app, as `luciole install` leaves it: its record and its binary.
const build = join(base, "data/luciole/apps/demo/ab12");
mkdirSync(build, { recursive: true });
const ran = join(base, "ran");
const binary = join(build, "demo");
writeFileSync(
  binary,
  `#!/bin/sh\n# luciole-binary:1:demo:ab12:bun-test;\necho "demo ran $*" >> "${ran}"\nexit 3\n`,
);
chmodSync(binary, 0o755);
writeFileSync(
  join(base, "data/luciole/apps/demo/installed.json"),
  JSON.stringify({
    app: "demo",
    package: "@ada/demo",
    version: "1.0.0",
    buildId: "ab12",
    target: "bun-test",
    registry: UNREACHABLE,
    installedAt: "2026-09-24T00:00:00Z",
  }),
);
await using t = await drive({
  command: [BUN, CLI],
  cols: 110,
  rows: 30,
  cwd: base,
  env: {
    XDG_DATA_HOME: join(base, "data"),
    XDG_STATE_HOME: join(base, "state"),
    XDG_CONFIG_HOME: join(base, "config"),
    XDG_CACHE_HOME: join(base, "cache"),
    LUCIOLE_REGISTRY: UNREACHABLE,
  },
});
const wait = (text: string) => t.waitFor(text);

await wait("INSTALLED (1)");
await wait("@ada/demo@1.0.0");
// Enter on the installed app: the launcher quits, the app runs, the launcher returns.
t.write(Keys.enter);
await wait("demo exited with 3");
assert.equal(readFileSync(ran, "utf8"), "demo ran \n");
// A path that is no app: explained once back in the launcher.
await t.type("\t\t", FOCUS_MS);
t.write("./nowhere");
await wait("./nowhere");
t.write(Keys.enter);
await wait("not a luciole app");
// Words search the registry, here unreachable: the status line says so.
await t.type("\t\t", FOCUS_MS);
t.write("notes");
await wait("notes");
t.write(Keys.enter);
await wait("unreachable");
await t.quit();
// The launcher's Server wrote its log in the user's state directory, not the screen.
assert.ok(existsSync(join(base, "state/luciole/luciole/server.log")), "no Server log");

report({
  launcherPTY: true,
  launchedInstalledApp: true,
  returnedWithExitStatus: true,
  explainedBadTarget: true,
  explainedUnreachableRegistry: true,
  terminalRestored: true,
});
