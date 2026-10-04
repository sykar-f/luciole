/**
 * Local multiplexer production smoke: built artefacts, separate Server and Client, real PTY.
 *
 * Journeys: a shell and vim side by side → typing reaches the active pane → Ctrl+C
 * interrupts the shell's job instead of quitting → the Ctrl+O prefix moves the keys to vim
 * → vim edits and quits, its pane closes → a new shell pane opens and exits → the window
 * shrinks and the program sees it → Ctrl+O q quits, the terminal is restored and no pane
 * program survives. Then mdreader inline next to a shell (<Embed>): keys go to the active
 * pane only, the same prefix moves them, and Ctrl+C in the application closes its pane,
 * not the multiplexer. Observes PTY output, not photons.
 */
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ctrl, drive, type Driver } from "./driver";
import {
  alive,
  BUN,
  build,
  commandOutput,
  eventually,
  example,
  report,
  startServer,
  temporaryDirectory,
} from "./harness";

const APP = example("mux");
const MDREADER = example("mdreader");
const VIM = commandOutput(["which", "vim"]).trim() || undefined;
const COLS = 120;
const ROWS = 30;
const PREFIX = ctrl("o");
const SHELL_MS = 400;
const RESIZE_MS = 500;
// The multiplexer's frame around a pane: its title row and borders.
const PANE_CHROME_ROWS = 3;
const PANE_CHROME_COLS = 2;

/** The multiplexer's Client, its panes running `env.MUX_PANES`. */
const startMux = (url: string, directory: string, env: Record<string, string>) =>
  drive({
    command: [BUN, join(APP, ".luciole/client/index.js"), "--url", url],
    cols: COLS,
    rows: ROWS,
    env: {
      NODE_ENV: "production",
      XDG_STATE_HOME: join(directory, "state"),
      SHELL: "/bin/sh",
      PS1: "$ ",
      ENV: "",
      ...env,
    },
    settle: 150,
  });
/** Ctrl+O q: the multiplexer quits and gives the terminal back. */
async function quitMux(t: Driver) {
  await t.type(PREFIX);
  await t.quit("q");
}

build(APP);
const right = VIM ? [VIM, "-u", "NONE", "-N"] : ["/bin/sh"];
{
  using directory = temporaryDirectory("mux-pty-");
  const pidfile = join(directory.path, "shell.pid");
  await using server = await startServer(APP);
  await using t = await startMux(server.url, directory.path, {
    MUX_PANES: JSON.stringify([["/bin/sh"], right]),
  });
  await t.waitFor("MUX · pane 0 of 2");
  await t.waitFor("Ctrl+O then"); // the Server-rendered page
  await t.waitFor("$ ");

  // Typing reaches the active pane; the shell records its pid for the last check.
  await t.type(`echo $$ > ${pidfile}; printf 'o%sk\\n' K\r`);
  await t.waitFor("oKk");
  const shellPid = Number(readFileSync(pidfile, "utf8").trim());

  // Ctrl+C interrupts the shell's foreground job; the multiplexer keeps running.
  await t.type("sleep 30\r", SHELL_MS);
  await t.type(ctrl("c"));
  await t.type("printf 's%s\\n' $?\r");
  await t.waitFor("s130");
  assert.ok(t.running, "Ctrl+C quit the multiplexer");

  // The prefix moves the keys to the other pane.
  await t.type(PREFIX);
  await t.type("o");
  await t.waitFor("MUX · pane 1 of 2");
  if (VIM) {
    await t.type("ihello-from-vim", 300);
    await t.escape(SHELL_MS);
    await t.waitFor("hello-from-vim");
    await t.type(":q!\r");
  } else await t.type("exit\r");
  // Its program ended: the pane closes and the shell has the keys again.
  await t.waitFor("MUX · pane 0 of 1");

  // A new shell pane, closed by its own exit.
  await t.type(PREFIX);
  await t.type("c");
  await t.waitFor("MUX · pane 2 of 2");
  await t.type("exit\r");
  await t.waitFor("MUX · pane 0 of 1");

  // The window shrinks: the program in the pane sees its new size.
  await t.type("stty size\r", SHELL_MS);
  const wide = await t.text();
  const [cols, rows] = [COLS - 30, ROWS - 6];
  t.resize(cols, rows);
  await t.pause(RESIZE_MS);
  await t.type("clear; stty size\r");
  await t.waitFor(`${rows - PANE_CHROME_ROWS} ${cols - PANE_CHROME_COLS}`);
  assert.notEqual(await t.text(), wide);

  // Quit through the prefix: the terminal comes back, no pane program survives.
  await quitMux(t);
  assert.ok(
    await eventually(() => !alive(shellPid)),
    `pane shell ${shellPid} survived the multiplexer`,
  );
}
{
  // mdreader inline next to a shell: one prefix for both, keys to the active pane only.
  build(MDREADER);
  using directory = temporaryDirectory("mux-inline-pty-");
  const library = join(directory.path, "docs");
  mkdirSync(library);
  writeFileSync(join(library, "README.md"), "# Handbook\n\nalpha-inline\n");
  writeFileSync(join(library, "guide.md"), "# Guide\n\nbeta-inline\n");
  await using mux = await startServer(APP);
  await using docs = await startServer(MDREADER, { MD_PATH: library });
  const apps = [{ name: "docs", bundle: join(MDREADER, ".luciole/app"), url: docs.url }];
  await using t = await startMux(mux.url, directory.path, {
    MUX_PANES: JSON.stringify([["/bin/sh"]]),
    MUX_APPS: JSON.stringify(apps),
  });
  await t.waitFor("MUX · pane 0 of 2");
  await t.waitFor("docs (luciole)");
  await t.waitFor("alpha-inline");
  await t.waitFor("$ ");

  // The shell has the keys: `[` is text for it, not mdreader's "previous document".
  await t.type("printf 'o%sk\\n' '['\r");
  await t.waitFor("o[k");
  await t.pause(SHELL_MS);
  assert.ok((await t.text()).includes("alpha-inline"), await t.text());

  // The one prefix moves the keys to the application; `[` is now mdreader's.
  await t.type(PREFIX);
  await t.type("o");
  await t.waitFor("MUX · pane 1 of 2");
  await t.type("[");
  await t.waitFor("beta-inline");

  // Ctrl+C in the application closes its pane, not the multiplexer.
  await t.type(ctrl("c"));
  await t.waitFor("MUX · pane 0 of 1");
  await t.waitFor("docs (luciole)", { absent: true });
  assert.ok(t.running, "Ctrl+C in the embedded application quit the multiplexer");
  await t.type("printf 'b%sk\\n' ack\r");
  await t.waitFor("backk");
  await quitMux(t);
}

report({
  productionPTY: true,
  vim: Boolean(VIM),
  typingReachesActivePane: true,
  ctrlCReachesProgram: true,
  prefixMovesKeys: true,
  exitedPaneCloses: true,
  resizeReachesProgram: true,
  quitRestoresTerminal: true,
  noSurvivingPaneProgram: true,
  inlineLuciolePane: true,
  keysOnlyToActivePane: true,
  ctrlCClosesAppPaneOnly: true,
});
