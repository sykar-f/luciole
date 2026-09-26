import { expect, test } from "bun:test";
import { z } from "zod";
import {
  ArgsError,
  argsFingerprint,
  decodeLaunchArgs,
  defineArgs,
  encodeLaunchArgs,
} from "../packages/airtty/src/args";
import { splitArgs, runtimeHelp } from "../packages/airtty/src/launcher/app-args";
import { BUILT_FLAGS, builtArgs } from "../packages/airtty/src/launcher";
import { messageOf } from "../packages/airtty/src/guards";
import { rejectionOf } from "./helpers";

const cli = defineArgs({
  summary: "A terminal client for coding agents",
  options: z
    .object({
      harness: z
        .enum(["claude", "codex", "pi", "opencode"])
        .optional()
        .meta({ short: "H", description: "Agent harness" }),
      cwd: z.string().optional().meta({ kind: "path", placeholder: "DIR" }),
      model: z.string().optional().meta({ short: "m", env: "CODER_MODEL" }),
      mode: z.enum(["read", "ask", "edits", "full"]).default("ask"),
      resume: z
        .union([z.literal(true), z.string()])
        .optional()
        .meta({ placeholder: "ID", description: "Resume the last session, or <ID>" }),
      maxTurns: z.coerce.number().int().positive().optional(),
      verbose: z.boolean().default(false).meta({ short: "v" }),
      quiet: z.boolean().optional().meta({ short: "q" }),
      tag: z.array(z.string()).optional(),
    })
    .strict(),
  examples: ["coder -H codex --resume"],
});

type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;

const parse = (...argv: string[]) => cli.parse(argv, { cwd: "/work", env: {} });
const refusal = async (...argv: string[]) => messageOf(await rejectionOf(parse(...argv)));

test("the grammar follows the schema: short, kebab, optional values, switches, lists", async () => {
  const value = await parse("-H", "codex", "--cwd", "sub", "--resume", "--max-turns=3", "-vq");
  expect(value).toEqual({
    harness: "codex",
    cwd: "/work/sub",
    mode: "ask",
    resume: true,
    maxTurns: 3,
    verbose: true,
    quiet: true,
  });
  // The parsed value is typed by the schema: no code generation.
  const typed: Equal<typeof value.harness, "claude" | "codex" | "pi" | "opencode" | undefined> =
    true;
  const resume: Equal<typeof value.resume, true | string | undefined> = true;
  expect([typed, resume]).toEqual([true, true]);
  expect(await parse("--resume", "abc", "-Hpi", "--no-verbose")).toMatchObject({
    resume: "abc",
    harness: "pi",
    verbose: false,
  });
  // An optional value never swallows the next flag.
  expect(await parse("--resume", "-H", "claude")).toMatchObject({
    resume: true,
    harness: "claude",
  });
  expect(await parse("--resume=x")).toMatchObject({ resume: "x" });
  expect(await parse("--tag", "a", "--tag", "b")).toMatchObject({ tag: ["a", "b"] });
  expect(await parse("--mode=full", "--")).toMatchObject({ mode: "full" });
});

test("a variable stands for an absent flag; the command line wins", async () => {
  const env = { CODER_MODEL: "from-env" };
  expect(await cli.parse([], { cwd: "/", env })).toMatchObject({ model: "from-env" });
  expect(await cli.parse(["-m", "given"], { cwd: "/", env })).toMatchObject({ model: "given" });
});

test("usage errors name the flag, suggest a close one, and exit with code 2", async () => {
  expect(await refusal("--harnes", "codex")).toBe(
    "Unknown option --harnes (did you mean --harness?)",
  );
  expect(await refusal("-H", "cladue")).toBe(
    '--harness: expected one of claude|codex|pi|opencode, got "cladue" (did you mean claude?)',
  );
  expect(await refusal("--mode")).toBe("--mode needs a value");
  expect(await refusal("--max-turns", "x")).toBe('--max-turns: expected a number, got "x"');
  expect(await refusal("--max-turns", "-2")).toStartWith("--max-turns: ");
  expect(await refusal("--verbose=yes")).toContain("takes no value");
  expect(await refusal("-v", "-v")).toBe("--verbose is given twice");
  expect(await refusal("stray")).toContain("Unexpected argument stray");
  expect(await refusal("-x")).toBe("Unknown option -x");
  const error = await rejectionOf(parse("--nope"));
  expect(error).toBeInstanceOf(ArgsError);
  expect(error instanceof ArgsError && error.exitCode).toBe(2);
});

test("required options are named when missing", async () => {
  const strict = defineArgs({ options: z.object({ harness: z.enum(["a", "b"]) }) });
  expect(messageOf(await rejectionOf(strict.parse([], { cwd: "/" })))).toBe("Missing --harness");
});

test("the runtime's flags are reserved, and unsupported shapes refused", () => {
  const declare = (options: z.ZodObject) => () => defineArgs({ options }).flags();
  expect(declare(z.object({ url: z.string() }))).toThrow("--url is reserved by airtty");
  expect(declare(z.object({ new: z.boolean() }))).toThrow("--new is reserved");
  expect(declare(z.object({ helpMe: z.boolean().meta({ short: "h" }) }))).toThrow("-h is reserved");
  expect(declare(z.object({ nested: z.object({ a: z.string() }) }))).toThrow("unsupported schema");
  expect(
    declare(z.object({ a: z.string().meta({ short: "x" }), b: z.string().meta({ short: "x" }) })),
  ).toThrow("-x names both --a and --b");
});

test("--help lists the application's options, then the runtime's", () => {
  expect(
    cli.help({ name: "coder", version: "0.1.0", runtime: runtimeHelp(BUILT_FLAGS) }),
  ).toMatchSnapshot();
});

test("one set of arguments, one fingerprint, whatever the order", async () => {
  const a = await parse("-H", "codex", "--mode", "full");
  const b = await parse("--mode", "full", "-H", "codex");
  expect(argsFingerprint(a)).toBe(argsFingerprint(b));
  expect(argsFingerprint(a)).toMatch(/^[0-9a-f]{16}$/);
  expect(argsFingerprint(await parse("-H", "pi"))).not.toBe(argsFingerprint(a));
});

test("arguments travel to the Server as JSON, and only as the schema of that JSON", () => {
  expect(decodeLaunchArgs(encodeLaunchArgs(["-H", "codex"], "/work"))).toEqual({
    v: 1,
    argv: ["-H", "codex"],
    cwd: "/work",
  });
  expect(decodeLaunchArgs(undefined)).toEqual({ v: 1, argv: [] });
  expect(() => decodeLaunchArgs("{")).toThrow("not JSON");
  expect(() => decodeLaunchArgs('{"v":2,"argv":[]}')).toThrow(ArgsError);
});

test("a launcher takes its own flags out, and leaves the rest to the application", () => {
  expect(
    splitArgs(["-H", "codex", "--grace", "0", "--url=u", "--", "--grace"], BUILT_FLAGS),
  ).toEqual({
    flags: new Map([
      ["grace", "0"],
      ["url", "u"],
    ]),
    app: ["-H", "codex", "--grace"],
  });
  expect(() => splitArgs(["--grace"], BUILT_FLAGS)).toThrow("--grace needs a value");
  expect(builtArgs(["-H", "codex", "--grace", "1m"])).toMatchObject({
    graceMs: 60_000,
    app: ["-H", "codex"],
    help: false,
  });
  expect(builtArgs(["-h"]).help).toBe(true);
  // A Client joins a running Server: arguments would configure nothing.
  expect(() => builtArgs(["--url", "unix:/x", "-H", "codex"])).toThrow(
    "application arguments configure a Server",
  );
  // What only a compiled binary does is said as before.
  expect(() => builtArgs(["--on", "host"])).toThrow("airtty build --compile");
});
