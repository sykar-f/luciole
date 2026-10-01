import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * pi has no approvals: every tool runs unasked. This
 * extension, loaded into pi with `-e`, stops each tool call that coder's permission mode
 * does not allow and asks through pi's extension dialogs, which reach coder as
 * `extension_ui_request`s. It is security code: whatever it cannot decide, it blocks.
 *
 *   read   reads only (read, grep, find, ls); anything else is blocked
 *   ask    every tool but reads is asked
 *   edits  edits and writes pass; bash and other tools are asked
 *   full   nothing is asked
 *
 * The mode comes from `--coder-mode`, and changes with the `/coder-mode <mode>` command.
 * A question is a `select` whose title is `coder:approval {json}`: coder parses it; any
 * answer but an allowing one (a timeout, a cancellation, an unknown label) blocks.
 *
 * Plain JavaScript in a string: pi loads it from a file, and coder's Server is a bundle
 * (or a compiled binary) where no source file exists at run time.
 */
export const GATE_TITLE = "coder:approval ";
export const ALLOW_ONCE = "Allow once";
export const ALLOW_SESSION = "Allow for this session";
export const DENY = "Deny";
export const MODE_COMMAND = "coder-mode";

export const PI_GATE_SOURCE = `// coder's approval gate for pi (examples/coder/server/pi-gate.ts). Generated: do not edit.
const TITLE = ${JSON.stringify(GATE_TITLE)};
const ALLOW_ONCE = ${JSON.stringify(ALLOW_ONCE)};
const ALLOW_SESSION = ${JSON.stringify(ALLOW_SESSION)};
const DENY = ${JSON.stringify(DENY)};
const MODES = new Set(["read", "ask", "edits", "full"]);
const READS = new Set(["read", "grep", "find", "ls"]);
const EDITS = new Set(["edit", "write"]);
const DEFAULT_TOOLS = ["read", "bash", "edit", "write"];

export default function coderGate(pi) {
  pi.registerFlag("coder-mode", { type: "string", default: "ask", description: "coder: permission mode" });
  let mode;
  let before;
  // Allowed for the session: a tool, or one exact bash command.
  const allowed = new Set();
  const current = () => {
    const value = mode ?? pi.getFlag("coder-mode");
    // An unknown mode asks: the gate never widens by mistake.
    return MODES.has(value) ? value : "ask";
  };
  const readOnly = (tools) => tools.length > 0 && tools.every((tool) => READS.has(tool));
  const restrict = (next) => {
    try {
      const active = pi.getActiveTools();
      if (next === "read") {
        if (!readOnly(active)) before = active;
        pi.setActiveTools([...READS]);
      } else if (readOnly(active)) {
        // Started read-only (--tools), or back from read: pi's default tools again.
        pi.setActiveTools(before ?? DEFAULT_TOOLS);
        before = undefined;
      }
    } catch {}
  };
  pi.registerCommand(${JSON.stringify(MODE_COMMAND)}, {
    description: "coder: set the permission mode (read, ask, edits, full)",
    handler: async (args, ctx) => {
      const next = String(args ?? "").trim();
      if (!MODES.has(next)) {
        ctx.ui.notify("coder-mode: expected read, ask, edits or full", "error");
        return;
      }
      mode = next;
      restrict(next);
    },
  });
  pi.on("session_start", async () => restrict(current()));
  pi.on("tool_call", async (event, ctx) => {
    const tool = String(event.toolName);
    const input = event.input ?? {};
    const now = current();
    if (READS.has(tool)) return undefined;
    if (now === "read") return { block: true, reason: "coder is in read-only mode" };
    if (now === "full") return undefined;
    if (now === "edits" && EDITS.has(tool)) return undefined;
    const key = tool === "bash" ? "bash:" + String(input.command) : tool;
    if (allowed.has(key)) return undefined;
    if (!ctx.hasUI) return { block: true, reason: "No one can approve this action" };
    const choice = await ctx.ui.select(TITLE + JSON.stringify({ tool, input }), [ALLOW_ONCE, ALLOW_SESSION, DENY]);
    if (choice === ALLOW_ONCE) return undefined;
    if (choice === ALLOW_SESSION) {
      allowed.add(key);
      return undefined;
    }
    return { block: true, reason: "The user declined this action" };
  });
}
`;

/** The gate as a private file pi can load; one per process is enough. */
let written: string | undefined;
export function gateFile() {
  if (written) return written;
  const directory = mkdtempSync(join(tmpdir(), "coder-pi-gate-"));
  const file = join(directory, "coder-gate.js");
  writeFileSync(file, PI_GATE_SOURCE, { mode: 0o600 });
  written = file;
  return file;
}
