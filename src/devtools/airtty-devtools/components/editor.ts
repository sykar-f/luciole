import { isAbsolute, join } from "node:path";
import type { CliRenderer } from "@opentui/core";

/**
 * Opens `file:line` in `$VISUAL` or `$EDITOR`. A terminal editor takes this pane: the
 * DevTools' renderer is suspended while it runs, then resumed. A graphical one is only
 * started. Returns what to tell the user.
 */
const GOTO: Record<string, (file: string, line: string) => string[]> = {
  code: (f, l) => ["-g", `${f}:${l}`],
  cursor: (f, l) => ["-g", `${f}:${l}`],
  codium: (f, l) => ["-g", `${f}:${l}`],
  zed: (f, l) => [`${f}:${l}`],
  subl: (f, l) => [`${f}:${l}`],
  hx: (f, l) => [`${f}:${l}`],
  idea: (f, l) => ["--line", l, f],
  webstorm: (f, l) => ["--line", l, f],
};
const GRAPHICAL = new Set(["code", "cursor", "codium", "zed", "subl", "idea", "webstorm"]);

export function openInEditor(renderer: CliRenderer, root: string | undefined, source: string) {
  const editor = (process.env.VISUAL ?? process.env.EDITOR ?? "").trim();
  if (!editor) return "Set $EDITOR (or $VISUAL) to open sources.";
  const match = /^(.*):(\d+)$/.exec(source);
  const [path, line] = match ? [match[1] ?? source, match[2] ?? "1"] : [source, "1"];
  const file = isAbsolute(path) || !root ? path : join(root, path);
  const [command = editor, ...flags] = editor.split(/\s+/);
  const name = command.split("/").at(-1) ?? command;
  const args = [...flags, ...(GOTO[name]?.(file, line) ?? [`+${line}`, file])];
  if (GRAPHICAL.has(name)) {
    Bun.spawn([command, ...args], { stdio: ["ignore", "ignore", "ignore"] }).unref();
    return `Opened ${path}:${line} in ${name}.`;
  }
  renderer.suspend();
  try {
    Bun.spawnSync([command, ...args], { stdio: ["inherit", "inherit", "inherit"] });
  } finally {
    renderer.resume();
  }
  return `Edited ${path}:${line}.`;
}
