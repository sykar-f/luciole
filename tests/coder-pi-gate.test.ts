import { beforeAll, expect, test } from "bun:test";
import { z } from "zod";
import {
  ALLOW_ONCE,
  ALLOW_SESSION,
  DENY,
  GATE_TITLE,
  gateFile,
} from "../examples/coder/server/pi-gate";

// The gate is the only thing between pi and the user's files: it is loaded here as pi
// loads it, into a stand-in `pi`, and every mode is tried on every kind of tool.
type Handler = (event: unknown, ctx: unknown) => Promise<unknown>;
type Command = { handler: (args: string, ctx: unknown) => Promise<void> };
const GateModule = z.object({ default: z.function() });

let install: (pi: unknown) => void;
beforeAll(async () => {
  const loaded = GateModule.parse(await import(gateFile()));
  install = (pi) => void Reflect.apply(loaded.default, undefined, [pi]);
});

/** A pi with the gate installed; `answer` plays the user for each dialog. */
function gate(
  flag: string | undefined,
  answer: (title: string) => string | undefined = () => undefined,
  tools: string[] = ["read", "bash", "edit", "write"],
) {
  const handlers = new Map<string, Handler>();
  const commands = new Map<string, Command>();
  const asked: { tool: string; input: unknown }[] = [];
  const notes: string[] = [];
  let active = tools;
  const pi = {
    registerFlag: () => {},
    getFlag: () => flag,
    registerCommand: (name: string, command: Command) => commands.set(name, command),
    on: (event: string, handler: Handler) => handlers.set(event, handler),
    getActiveTools: () => active,
    setActiveTools: (tools: string[]) => (active = tools),
  };
  install(pi);
  const ui = {
    select: async (title: string) => {
      expect(title.startsWith(GATE_TITLE)).toBe(true);
      asked.push(
        z
          .object({ tool: z.string(), input: z.unknown() })
          .parse(JSON.parse(title.slice(GATE_TITLE.length))),
      );
      return answer(title);
    },
    notify: (message: string) => notes.push(message),
  };
  const call = (toolName: string, input: Record<string, unknown> = {}, hasUI = true) =>
    handlers.get("tool_call")?.(
      { type: "tool_call", toolName, toolCallId: "t1", input },
      { hasUI, ui },
    );
  const mode = (value: string) => commands.get("coder-mode")?.handler(value, { ui });
  return { call, mode, asked, notes, active: () => active };
}
const blocked = { block: true };

test("read: reads pass, everything else is blocked without asking", async () => {
  const g = gate("read", () => ALLOW_ONCE);
  for (const tool of ["read", "grep", "find", "ls"]) expect(await g.call(tool)).toBeUndefined();
  for (const tool of ["bash", "edit", "write", "mcp_tool"])
    expect(await g.call(tool)).toMatchObject(blocked);
  expect(g.asked).toEqual([]);
});

test("ask: every non-read tool is asked; only an allowing answer lets it run", async () => {
  const answers = [ALLOW_ONCE, DENY, undefined, "Yes", ""];
  const g = gate("ask", () => answers.shift());
  expect(await g.call("read")).toBeUndefined();
  expect(await g.call("bash", { command: "ls" })).toBeUndefined();
  // Denied, timed out (undefined), or an answer that is not one of the gate's: blocked.
  for (let i = 0; i < 4; i++) expect(await g.call("edit", { path: "a" })).toMatchObject(blocked);
  expect(g.asked.map((a) => a.tool)).toEqual(["bash", "edit", "edit", "edit", "edit"]);
  expect(g.asked[0]).toEqual({ tool: "bash", input: { command: "ls" } });
});

test("for this session: the same bash command, or the same tool, is not asked again", async () => {
  const g = gate("ask", () => ALLOW_SESSION);
  await g.call("bash", { command: "bun test" });
  expect(await g.call("bash", { command: "bun test" })).toBeUndefined();
  await g.call("bash", { command: "rm -rf /" });
  await g.call("write", { path: "a" });
  expect(await g.call("write", { path: "b" })).toBeUndefined();
  expect(g.asked.map((a) => a.tool)).toEqual(["bash", "bash", "write"]);
});

test("edits: edits and writes pass, bash is still asked; full: nothing is asked", async () => {
  const edits = gate("edits", () => DENY);
  expect(await edits.call("edit")).toBeUndefined();
  expect(await edits.call("write")).toBeUndefined();
  expect(await edits.call("bash", { command: "curl x" })).toMatchObject(blocked);
  const full = gate("full");
  for (const tool of ["bash", "edit", "write", "custom"])
    expect(await full.call(tool)).toBeUndefined();
  expect(full.asked).toEqual([]);
});

test("without a UI, or with an unknown mode, the gate fails closed", async () => {
  expect(await gate("ask", () => ALLOW_ONCE).call("bash", { command: "ls" }, false)).toMatchObject(
    blocked,
  );
  const unknown = gate("yolo", () => DENY);
  expect(await unknown.call("bash", { command: "ls" })).toMatchObject(blocked);
  expect(unknown.asked).toHaveLength(1);
  const missing = gate(undefined, () => DENY);
  expect(await missing.call("write")).toMatchObject(blocked);
});

test("/coder-mode switches the mode, restricts tools in read, and refuses unknown modes", async () => {
  const g = gate("full", () => DENY);
  await g.mode("read");
  expect(g.active()).toEqual(["read", "grep", "find", "ls"]);
  expect(await g.call("bash")).toMatchObject(blocked);
  await g.mode("ask");
  expect(g.active()).toEqual(["read", "bash", "edit", "write"]);
  expect(await g.call("bash", { command: "ls" })).toMatchObject(blocked);
  await g.mode("everything");
  expect(g.notes).toEqual(["coder-mode: expected read, ask, edits or full"]);
  expect(await g.call("write")).toMatchObject(blocked);
});

test("started read-only by --tools, leaving read mode gives pi's default tools back", async () => {
  const g = gate("read", () => ALLOW_ONCE, ["read", "grep", "find", "ls"]);
  await g.mode("ask");
  expect(g.active()).toEqual(["read", "bash", "edit", "write"]);
});
