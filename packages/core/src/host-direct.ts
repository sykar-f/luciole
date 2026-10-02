/**
 * What a Client does itself when an application asks its host (src/host.ts) with the
 * user's rights: the system's clipboard, notification and URL tools, its keychain. The
 * web runtime answers with the page's own APIs instead (docs/WEB.md, W4).
 */
import { spawn } from "node:child_process";
import type { HostRequest } from "./host";

type Tool = readonly string[];
const TOOLS: Partial<Record<NodeJS.Platform, Record<string, readonly Tool[]>>> = {
  darwin: {
    copy: [["pbcopy"]],
    paste: [["pbpaste"]],
    open: [["open"]],
  },
  linux: {
    copy: [["wl-copy"], ["xclip", "-selection", "clipboard"], ["xsel", "--clipboard", "--input"]],
    paste: [
      ["wl-paste", "--no-newline"],
      ["xclip", "-selection", "clipboard", "-o"],
      ["xsel", "--clipboard", "--output"],
    ],
    open: [["xdg-open"]],
  },
};

/** Runs the first installed tool; its exit code and output. */
function runTool(tools: readonly Tool[], args: readonly string[], input?: string) {
  const [program, ...fixed] = tools.find(([name]) => name && Bun.which(name)) ?? [];
  if (!program)
    return Promise.reject(new Error(`None of ${tools.map((t) => t[0]).join(", ")} is installed`));
  return new Promise<{ code: number | null; stdout: string }>((resolve, reject) => {
    const child = spawn(program, [...fixed, ...args], { stdio: ["pipe", "pipe", "ignore"] });
    let stdout = "";
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
    child.once("error", reject);
    child.once("close", (code) => resolve({ code, stdout }));
    child.stdin.end(input);
  });
}
const tools = (kind: string) => TOOLS[process.platform]?.[kind] ?? [];
async function succeed(run: Promise<{ code: number | null; stdout: string }>, what: string) {
  const { code, stdout } = await run;
  if (code !== 0) throw new Error(`${what} failed (${code})`);
  return stdout;
}
// macOS keychain / Secret Service item of one origin: its service name keeps origins apart.
const secretService = (origin: string) => `luciole:${origin}`;
const SECRET_NOT_FOUND = 44;

/**
 * Performs a request with the user's rights, on this machine: what a standalone Client
 * or an inline pane does, and what the sandbox host does once it granted the request.
 * `origin` partitions secrets. `tabs.post` has no other tab to reach here.
 */
export function performDirectly(origin: string) {
  return async (request: HostRequest): Promise<unknown> => {
    switch (request.type) {
      case "clipboard.read":
        return succeed(runTool(tools("paste"), []), "Reading the clipboard");
      case "clipboard.write":
        await succeed(runTool(tools("copy"), [], request.text), "Writing the clipboard");
        return undefined;
      case "notify":
        if (process.platform === "darwin")
          // The texts are arguments, never AppleScript source.
          await succeed(
            runTool(
              [["osascript"]],
              [
                "-e",
                "on run argv",
                "-e",
                "display notification (item 2 of argv) with title (item 1 of argv)",
                "-e",
                "end run",
                request.title,
                request.body ?? "",
              ],
            ),
            "Notifying",
          );
        else
          await succeed(
            runTool([["notify-send"]], [request.title, request.body ?? ""]),
            "Notifying",
          );
        return undefined;
      case "open-url":
        await succeed(runTool(tools("open"), [request.url]), "Opening the URL");
        return undefined;
      case "secret": {
        const service = secretService(origin);
        const { code, stdout } =
          process.platform === "darwin"
            ? await runTool(
                [["security"]],
                ["find-generic-password", "-s", service, "-a", request.name, "-w"],
              )
            : await runTool(
                [["secret-tool"]],
                ["lookup", "service", service, "account", request.name],
              );
        if (code === 0) return stdout.replace(/\n$/, "");
        // Not stored: the application learns it is absent, as from an empty keychain.
        if (code === SECRET_NOT_FOUND || code === 1) return undefined;
        throw new Error(`Reading secret ${request.name} failed (${code})`);
      }
      case "tabs.post":
        return undefined;
    }
  };
}
