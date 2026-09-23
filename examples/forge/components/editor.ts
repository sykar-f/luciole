import "client-only";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Opens a file in the reviewer's own editor, on the reviewer's own terminal. Client and
// Server both run on Bun: without the marker, a page importing this module would build,
// and the editor would start on the Server's machine, in the Server's terminal. The
// build refuses this module anywhere in the Server graph outside a "use client" boundary.
//
// The file is a read-only snapshot in a private temporary directory, removed when the
// editor exits: Forge reviews revisions, it has no way to take local edits back.

/** The part of OpenTUI's renderer that hands the terminal over and takes it back. */
export type Terminal = { suspend(): void; resume(): void };
export type Opened = { editor: string; exitCode: number; edited: boolean };

/** `$VISUAL`, then `$EDITOR`, then `vi`, as git does. Whitespace separates arguments. */
export function editorCommand(env: Record<string, string | undefined> = process.env) {
  return (env.VISUAL?.trim() || env.EDITOR?.trim() || "vi").split(/\s+/);
}

// Editors known to accept `+LINE` before the file; others open at the top.
const LINE_ARGUMENT = /^(vi|vim|nvim|nano|emacs|emacsclient|micro|kak)$/;

/**
 * Suspends the renderer (alternate screen, raw mode and mouse released), runs the editor
 * with the terminal inherited, then restores the UI whatever happened. A graphical editor
 * must be told to wait (`code --wait`), as for git: the snapshot is removed on return.
 */
export async function openInEditor(
  terminal: Terminal,
  file: { name: string; content: string; line?: number },
): Promise<Opened> {
  const [editor, ...args] = editorCommand();
  const directory = await mkdtemp(join(tmpdir(), "forge-"));
  const path = join(directory, file.name);
  await writeFile(path, file.content, { mode: 0o444 });
  const line =
    file.line && LINE_ARGUMENT.test(editor.split("/").at(-1) ?? "") ? [`+${file.line}`] : [];
  terminal.suspend();
  try {
    const exitCode = await new Promise<number>((resolve, reject) => {
      spawn(editor, [...args, ...line, path], { stdio: "inherit" })
        .once("error", reject)
        .once("exit", (code) => resolve(code ?? 1));
    });
    return { editor, exitCode, edited: (await readFile(path, "utf8")) !== file.content };
  } finally {
    terminal.resume();
    await rm(directory, { recursive: true, force: true });
  }
}
