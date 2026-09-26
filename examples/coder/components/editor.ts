import "client-only";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Composes a prompt in the user's own editor, on the user's own terminal (the Client):
// the marker keeps this module out of the Server, where the editor would open on the
// Server's machine. Adapted from examples/forge/components/editor.ts.

/** The part of OpenTUI's renderer that hands the terminal over and takes it back. */
export type Terminal = { suspend(): void; resume(): void };

/** `$VISUAL`, then `$EDITOR`, then `vi`, as git does. Whitespace separates arguments. */
export function editorCommand(env: Record<string, string | undefined> = process.env) {
  return (env.VISUAL?.trim() || env.EDITOR?.trim() || "vi").split(/\s+/);
}

/**
 * Suspends the renderer, edits `text` in a private temporary file, restores the UI
 * whatever happened, and resolves with the text as saved (unchanged if the editor
 * failed). A graphical editor must be told to wait (`code --wait`).
 */
export async function editText(terminal: Terminal, text: string): Promise<string> {
  const [editor = "vi", ...args] = editorCommand();
  const directory = await mkdtemp(join(tmpdir(), "coder-"));
  const path = join(directory, "PROMPT.md");
  await writeFile(path, text, { mode: 0o600 });
  terminal.suspend();
  try {
    const code = await new Promise<number>((resolve, reject) => {
      spawn(editor, [...args, path], { stdio: "inherit" })
        .once("error", reject)
        .once("exit", (exit) => resolve(exit ?? 1));
    });
    return code === 0 ? (await readFile(path, "utf8")).replace(/\n$/, "") : text;
  } finally {
    terminal.resume();
    await rm(directory, { recursive: true, force: true });
  }
}
