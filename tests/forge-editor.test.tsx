/** @jsxImportSource @opentui/react */
import { beforeAll, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build } from "../packages/airtty/src/build";
import { messageOf } from "../packages/airtty/src/guards";
import { forgeDirectory, startForge } from "./forge-helpers";
import { present, rejectionOf } from "./helpers";

beforeAll(async () => {
  await build(forgeDirectory);
}, 60000);

const editorModule = join(forgeDirectory, "components/editor.ts");

test("a Server page importing Forge's editor launcher does not build", async () => {
  // The real module, reached from a page the way FilesReview reaches it from its boundary.
  const dir = await mkdtemp(join(tmpdir(), "forge-editor-build-"));
  try {
    await mkdir(join(dir, "app"), { recursive: true });
    await mkdir(join(dir, "components"), { recursive: true });
    await Bun.write(
      join(dir, "app/layout.tsx"),
      `"use client";export default function Layout({children}){return children}`,
    );
    await Bun.write(
      join(dir, "app/page.tsx"),
      `import {editorCommand} from "../components/editor";export default function Page(){return <text>{editorCommand().join(" ")}</text>}`,
    );
    await Bun.write(join(dir, "components/editor.ts"), Bun.file(editorModule));
    expect(messageOf(await rejectionOf(build(dir)))).toMatch(
      /components\/editor\.ts:1:1: Client-only module in Server graph: it never runs on the Server\n {2}via app\/page\.tsx → components\/editor\.ts/,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
  // In Forge it sits behind FilesReview's "use client" boundary: Client bundle only.
  const client = await Bun.file(join(forgeDirectory, ".airtty/client/index.js")).text();
  const server = await Bun.file(join(forgeDirectory, ".airtty/server/index.js")).text();
  expect(client).toContain("emacsclient");
  expect(server).not.toContain("emacsclient");
}, 30000);

test("e opens the file under review in $EDITOR, on the Client, then restores the UI", async () => {
  const dir = await mkdtemp(join(tmpdir(), "forge-editor-"));
  const marker = join(dir, "marker.txt");
  // Named like a real editor, so Forge passes the cursor line as `+LINE`. It records the
  // process that started it, its arguments, the file's mode and content; FAKE_EDIT makes
  // it change the file, as `:w!` would.
  const editor = join(dir, "bin/nano");
  await mkdir(join(dir, "bin"));
  await Bun.write(
    editor,
    `#!/bin/sh
for last; do :; done
{
  echo "parent=$PPID"
  echo "args=$*"
  if [ -w "$last" ]; then echo "writable=yes"; else echo "writable=no"; fi
  echo "---"
  cat "$last"
} > "$FORGE_EDITOR_MARKER"
if [ -n "$FAKE_EDIT" ]; then chmod u+w "$last"; echo "local change" >> "$last"; fi
`,
  );
  await chmod(editor, 0o755);
  const forge = await startForge();
  const { ui, step, waitFor, operator } = forge;
  const saved = { ...process.env };
  // The Client runs in this process: its environment is the reviewer's terminal.
  Object.assign(process.env, {
    VISUAL: "",
    EDITOR: editor,
    TMPDIR: dir,
    FORGE_EDITOR_MARKER: marker,
  });
  try {
    await forge.signIn("bob");
    await step(() =>
      forge.app.router.navigate({
        to: "/repos/$repo/pulls/$number/files",
        params: { repo: "payments", number: "2" },
      }),
    );
    await waitFor("src/report.ts · typescript");
    await step(() => ui.mockInput.typeText("]"));
    await waitFor("src/settlement.ts · typescript");
    for (let i = 0; i < 8; i++) await step(() => ui.mockInput.typeText("j"));
    await waitFor("line 9");
    await step(() => ui.mockInput.typeText("e"));
    await waitFor("Viewed settlement@r1.ts in");

    const [head, content] = (await Bun.file(marker).text()).split("---\n");
    // Started by the Client process (this one), never by the Server.
    expect(head).toContain(`parent=${process.pid}\n`);
    expect(head).not.toContain(`parent=${forge.server.child.pid}\n`);
    const args = present(/^args=(.*)$/m.exec(head), "editor arguments")[1].split(" ");
    expect(args[0]).toBe("+9");
    expect(args[1]).toMatch(/\/forge-[^/]+\/settlement@r1\.ts$/);
    expect(head).toContain("writable=no");
    // The new side of the file at the reviewed revision, whole, as the Server stores it.
    const pull = present(operator.pull("payments", 2), "payments#2");
    const target = { repo: "payments", number: 2, revision: pull.revision };
    const source = present(
      operator.fileSource({ ...target, path: "src/settlement.ts", side: "new" }),
      "settlement.ts",
    );
    expect(content).toBe(source.content);
    // The snapshot is gone and the UI took the terminal back: keys work again.
    expect((await readdir(dir)).filter((name) => name.startsWith("forge-"))).toEqual([]);
    await step(() => ui.mockInput.typeText("["));
    await waitFor("src/report.ts · typescript");

    // An editor that writes anyway: the change is reported as discarded, never sent. The
    // cursor is on a deleted line here: the old side of the file is opened.
    process.env.FAKE_EDIT = "1";
    await step(() => ui.mockInput.typeText("e"));
    await waitFor("Edits discarded: report@r1.old.ts was a read-only snapshot");
    expect(/^args=\+\d+ \S+report@r1\.old\.ts$/m.test(await Bun.file(marker).text())).toBe(true);
    const report = present(
      operator.fileSource({ ...target, path: "src/report.ts", side: "old" }),
      "report.ts",
    );
    expect(report.content).not.toContain("local change");

    // No editor at all: a message, and the UI is still there.
    delete process.env.FAKE_EDIT;
    process.env.EDITOR = join(dir, "missing-editor");
    await step(() => ui.mockInput.typeText("e"));
    await waitFor("Could not start the editor · set $EDITOR");
    await step(() => ui.mockInput.typeText("]"));
    await waitFor("src/settlement.ts · typescript");
  } finally {
    await forge.stop();
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
    await rm(dir, { recursive: true, force: true });
  }
}, 60000);
