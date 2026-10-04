/**
 * `luciole ./app` for an app whose package.json says `"server": "per-launch"`, on PTYs:
 * two launches in one directory get a Server each; a Client killed with SIGKILL leaves
 * its Server in grace and the next launch takes that launch over (same Server, same
 * typed text); `--new` starts another; Ctrl+C stops each. Offline.
 */
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { z } from "zod";
import { LifetimeStatus } from "../../packages/core/src/launcher/lifetime";
import { ctrl, drive, type Driver } from "./driver";
import {
  BUN,
  CLI,
  ROOT,
  defer,
  eventually,
  HANG_MS,
  report,
  sessionKeeps,
  temporaryDirectory,
} from "./harness";

const TIMEOUT_MS = 60_000;

const APP: Record<string, string> = {
  "package.json": JSON.stringify({
    name: "launches",
    private: true,
    type: "module",
    luciole: { server: "per-launch", grace: "1m" },
  }),
  "app/args.ts": `import { defineArgs } from "@luciole-sh/core/args";
import { z } from "zod";
export default defineArgs({ options: z.object({ label: z.string().default("plain") }).strict() });`,
  "app/layout.tsx": `"use client";
import { useState } from "react";
import { Input } from "@luciole-sh/core/client";
export default function Layout({ children }) {
  const [text, setText] = useState("");
  return (
    <box flexDirection="column">
      {children}
      <Input name="launches/text" focused value={text} onInput={setText} width={40} />
    </box>
  );
}`,
  "app/page.tsx": `import { getLaunch } from "@luciole-sh/core/server";
import cli from "./args";
export default function Page() {
  const launch = getLaunch();
  return <text>{"LAUNCH " + (launch.id ?? "-") + " SCOPE " + launch.scope + " LABEL " + cli.get().label}</text>;
}`,
};

const Session = z.object({ pid: z.number().int(), server: z.string() }).loose();

async function status(socket: string) {
  try {
    const response = await fetch("http://localhost/lifetime/status", {
      unix: socket,
      signal: AbortSignal.timeout(HANG_MS),
    });
    return LifetimeStatus.parse(await response.json());
  } catch {
    return undefined;
  }
}

using directory = temporaryDirectory("luciole-pty-launches-");
// Under /tmp: a Unix socket's path is short (104 bytes on macOS).
using runtime = temporaryDirectory("luciole-rt-", "/tmp");
const app = join(directory.path, "launches");
for (const [name, text] of Object.entries(APP)) {
  mkdirSync(dirname(join(app, name)), { recursive: true });
  writeFileSync(join(app, name), text);
}
symlinkSync(join(ROOT, "node_modules"), join(app, "node_modules"), "dir");
const project = join(directory.path, "project");
mkdirSync(project);
const sessions = join(directory.path, "state/luciole/launches/sessions");
const sockets = () => {
  const at = join(runtime.path, "luciole");
  return existsSync(at)
    ? readdirSync(at)
        .filter((name) => name.endsWith(".sock"))
        .map((name) => join(at, name))
    : [];
};
await using _leftover = defer(async () => {
  for (const socket of sockets()) {
    const left = await status(socket);
    if (left) process.kill(left.pid, "SIGTERM");
  }
});
const start = (...args: string[]) =>
  drive({
    command: [BUN, CLI, app, ...args],
    cols: 100,
    rows: 12,
    cwd: project,
    env: {
      XDG_STATE_HOME: join(directory.path, "state"),
      XDG_RUNTIME_DIR: runtime.path,
      LUCIOLE_PING_MS: "500",
    },
  });
const wait = (t: Driver, text: string | RegExp) => t.waitFor(text, { timeout: TIMEOUT_MS });
const launchId = async (t: Driver) => {
  await wait(t, /LAUNCH [0-9a-f-]{36} SCOPE per-launch/);
  return /LAUNCH ([0-9a-f-]{36})/.exec(await t.text())?.[1] ?? "";
};

// Two launches in one directory, with the same arguments: a Server and a session each.
await using a = await start("--label", "same");
const first = await launchId(a);
await using b = await start("--label", "same");
const second = await launchId(b);
assert.notEqual(first, second);
assert.equal(sockets().length, 2, "one Server per launch");
assert.ok((await a.text()).includes("LABEL same"));
a.write("alpha words");
await wait(a, "alpha words");
// What the relaunch restores is what reached the session file.
await a.until(() => sessionKeeps(sessions, "alpha words"), "the session never kept the words");
const [serverOfFirst] = (
  await Promise.all(sockets().map(async (socket) => ({ socket, status: await status(socket) })))
).filter(({ status: s }) => s?.launch === first);
assert.ok(serverOfFirst?.status, "the first launch's Server reports its launch id");

// The first Client crashes: its Server waits in grace.
const crashed = readdirSync(sessions)
  .map((name) => Session.parse(JSON.parse(readFileSync(join(sessions, name), "utf8"))))
  .find((session) => session.server.endsWith(`!${first}`));
assert.ok(crashed, "the first launch keeps a session");
process.kill(crashed.pid, "SIGKILL");
await a.exited();
await eventually(async () => (await status(serverOfFirst.socket))?.graceUntil !== undefined);

// Relaunched with the same arguments: that launch again, its Server, its typed text.
{
  await using again = await start("--label", "same");
  assert.equal(await launchId(again), first);
  await wait(again, "alpha words");
  const back = await status(serverOfFirst.socket);
  assert.ok(back?.pid === serverOfFirst.status.pid && back.graceUntil === undefined);
  // `--new` never reattaches: a third launch, a third Server.
  {
    await using fresh = await start("--label", "same", "--new");
    const third = await launchId(fresh);
    assert.ok(third !== first && third !== second);
    assert.equal(sockets().length, 3);
    fresh.write(ctrl("c"));
    await fresh.exited();
  }
  again.write(ctrl("c"));
  await again.exited();
}
b.write(ctrl("c"));
await b.exited();
// Every Client quit on purpose: every Server stopped.
await eventually(async () => sockets().length === 0);

report({
  perLaunchPTY: true,
  twoLaunchesTwoServers: true,
  crashKeepsServerInGrace: true,
  relaunchTakesOverCrashedLaunch: true,
  typedTextRestored: true,
  newSkipsReattach: true,
  quitStopsEachServer: true,
});
