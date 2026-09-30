/**
 * `luciole http://…` on a real PTY: the generic Client opens an application from its Server.
 *
 * Journey, offline and on private XDG directories: a publisher key, mdreader built with a
 * signed bundle, its Server on a fixed local port → without --inline nothing opens → with
 * --inline the warning and the declared capabilities are shown, the key is pinned, the app
 * runs in a tab and follows its keys → a second launch needs no flag nor question → Ctrl+C
 * in the app closes its tab and the Client → a new publisher key is refused with the
 * `luciole trust` command to accept it → after `luciole trust` it opens again.
 */
import assert from "node:assert/strict";
import { join } from "node:path";
import { ctrl } from "./driver";
import { luciole, build, defer, report, temporaryDirectory } from "./harness";
import { MDREADER, openByUrl, privateEnvironment, publish, startLibrary } from "./published";

using directory = temporaryDirectory("luciole-pty-generic-");
const { env, docs } = privateEnvironment(directory.path, "generic");
let server: Awaited<ReturnType<typeof startLibrary>> | undefined;
// The example keeps an unsigned build, as the repository expects.
await using _unsigned = defer(async () => {
  await server?.stop();
  build(MDREADER, [], env);
});
const keyA = publish(env, join(directory.path, "publisher-a"));
server = await startLibrary(env, docs);
const { url, port } = server;
const open = (...args: string[]) => openByUrl(url, args, env, directory.path);

// Without --inline nothing of the application runs: refused where the sandbox does not
// exist, offered sandboxed on macOS, where no terminal confirms it here.
const refused = luciole([url], { env });
assert.notEqual(refused.exitCode, 0, refused.stderr);
assert.ok(
  refused.stderr.includes("--inline") || refused.stderr.includes("not opened"),
  refused.stderr,
);

{
  // First use: the warning, the capabilities, the pinned key; the app in a tab.
  await using t = await open("--inline", "--yes");
  await t.waitFor("alpha-generic");
  await t.waitFor("inline · confiance totale");
  await t.waitFor(`mdreader · ${url}`);
  const shown = t.output();
  assert.ok(shown.includes("Confiance totale") && shown.includes(keyA), shown.slice(0, 2000));
  assert.ok(shown.includes("Capacités déclarées (non appliquées)"));
  await t.type("["); // mdreader's key: the previous document
  await t.waitFor("beta-generic");
  await t.type(ctrl("o"));
  await t.quit("q");
}
{
  // Remembered: no flag, no question; Ctrl+C in the app closes its tab, then all.
  await using t = await open();
  await t.waitFor("alpha-generic");
  await t.quit();
}

// A new publisher key for the same origin: refused, with the command to accept it.
await server.stop();
const keyB = publish(env, join(directory.path, "publisher-b"));
server = await startLibrary(env, docs, port);
const changed = luciole([url], { env });
assert.notEqual(changed.exitCode, 0, JSON.stringify(changed));
assert.ok(changed.stderr.includes("publisher key changed"), changed.stderr);
assert.ok(changed.stderr.includes(`luciole trust ${url} ${keyB}`), changed.stderr);

{
  // Accepted out of band: it opens again.
  luciole(["trust", url, keyB], { env, check: true });
  await using t = await open();
  await t.waitFor("alpha-generic");
  await t.type(ctrl("o"));
  await t.quit("q");
}

report({
  productionPTY: true,
  refusedWithoutInline: true,
  warningAndCapabilitiesShown: true,
  firstUsePinned: true,
  appInTab: true,
  rememberedWithoutFlag: true,
  ctrlCClosesTab: true,
  changedKeyRefusedWithTrustCommand: true,
  trustCommandAccepts: true,
  terminalRestored: true,
});
