import type { CliRenderer } from "@opentui/core";

// Runs in the Client, on the terminal's machine: its clipboard is the user's. The system
// tool is tried first (a multiplexer may drop OSC 52), then OSC 52 through the terminal.
const TOOLS: Record<string, string[][]> = {
  darwin: [["pbcopy"]],
  linux: [["wl-copy"], ["xclip", "-selection", "clipboard"], ["xsel", "--clipboard", "--input"]],
};

async function viaTool(text: string) {
  for (const command of TOOLS[process.platform] ?? []) {
    if (!Bun.which(command[0])) continue;
    const tool = Bun.spawn(command, { stdin: "pipe", stdout: "ignore", stderr: "ignore" });
    void tool.stdin.write(text);
    await tool.stdin.end();
    if ((await tool.exited) === 0) return true;
  }
  return false;
}

/** Copies `text`; `false` when neither the system nor the terminal accepted it. */
export async function copy(renderer: CliRenderer, text: string) {
  if (await viaTool(text).catch(() => false)) return true;
  return renderer.isOsc52Supported() && renderer.copyToClipboardOSC52(text);
}
