/**
 * The application's arguments at the entry points that start its Server (`airtty dev`,
 * `airtty ./app`, an app binary, `serve`, `start`): the runtime's own flags are taken
 * out, the rest is parsed by the application's `app/args.ts` (src/args.ts) as a check,
 * with `--help` generated from it; the Server parses them again from `AIRTTY_ARGS`.
 */
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import {
  ARGS_VARIABLE,
  ArgsError,
  argsFingerprint,
  encodeLaunchArgs,
  isArgsDefinition,
  type ArgsDefinition,
  type HelpOptions,
} from "../args";

/** A runtime flag: `value` ones take the next word. */
export type RuntimeFlag = {
  name: string;
  value?: string;
  description: string;
  short?: string;
};

/** The `app/args.ts` a build bundled (`.airtty/args`), or `undefined` when it has none. */
export async function loadArgs(output: string, version?: string) {
  const file = resolve(output, "args/index.js");
  if (!existsSync(file)) return undefined;
  // A new query per build: a rebuilt module at the same path is evaluated again.
  return definitionOf(await import(`${file}${version ? `?${version}` : ""}`));
}

/** The default export of an arguments module, checked. */
export function definitionOf(imported: unknown) {
  const definition =
    typeof imported === "object" && imported !== null && "default" in imported
      ? imported.default
      : undefined;
  if (!isArgsDefinition(definition)) throw new Error("The arguments module holds no defineArgs()");
  return definition;
}

/**
 * Splits a command line into the runtime's flags (by name, before a `--`) and the
 * application's words, in order. A `--` ends the runtime's part: what follows is the
 * application's, even words that look like runtime flags.
 */
export function splitArgs(args: readonly string[], runtime: readonly RuntimeFlag[]) {
  const flags = new Map<string, string>();
  const app: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const word = args[i] ?? "";
    if (word === "--") {
      app.push(...args.slice(i + 1));
      break;
    }
    const at = word.indexOf("=");
    const name = word.startsWith("--") ? word.slice(2, at < 0 ? undefined : at) : undefined;
    const flag = runtime.find(
      (f) => (name !== undefined && f.name === name) || (f.short && word === `-${f.short}`),
    );
    if (!flag) {
      app.push(word);
      continue;
    }
    if (flag.value === undefined) {
      if (at >= 0) throw new ArgsError(`--${flag.name} takes no value`);
      flags.set(flag.name, "");
      continue;
    }
    const value = at >= 0 && name !== undefined ? word.slice(at + 1) : args[++i];
    if (value === undefined || value === "" || (at < 0 && value.startsWith("--")))
      throw new ArgsError(`--${flag.name} needs a value`);
    flags.set(flag.name, value);
  }
  return { flags, app };
}

/** The runtime's rows of a generated `--help`. */
export const runtimeHelp = (flags: readonly RuntimeFlag[]): HelpOptions["runtime"] =>
  flags.map((f) => ({
    flags: `${f.short ? `-${f.short}, ` : "    "}--${f.name}${f.value ? ` <${f.value}>` : ""}`,
    description: f.description,
  }));

export const HELP_FLAG: RuntimeFlag = { name: "help", short: "h", description: "Show this help" };
export const NEW_FLAG: RuntimeFlag = {
  name: "new",
  description: "Start a new session instead of reattaching a crashed one (per-launch apps)",
};

/** What a Server started by this launch receives: `AIRTTY_ARGS`, and the fingerprint. */
export type CheckedArgs = { env: Record<string, string>; fingerprint?: string };

/**
 * Checks the application's words before its Server starts: refused ones throw an
 * `ArgsError` (exit code 2). An application without `app/args.ts` takes none.
 */
export async function checkArgs(
  definition: ArgsDefinition | undefined,
  argv: readonly string[],
  { cwd, env = process.env, name }: { cwd: string; env?: NodeJS.ProcessEnv; name: string },
): Promise<CheckedArgs> {
  if (!definition) {
    if (argv.length)
      throw new ArgsError(
        `Unknown argument ${argv[0]}: ${name} declares no arguments (app/args.ts)`,
      );
    return { env: {} };
  }
  const value = await definition.parse(argv, { cwd, env });
  return {
    env: { [ARGS_VARIABLE]: encodeLaunchArgs(argv, cwd) },
    fingerprint: argsFingerprint(value),
  };
}

/** Words that configure a Server, refused where the Server is someone else's. */
export function refuseArgs(argv: readonly string[], why: string) {
  if (argv.length)
    throw new ArgsError(`Unexpected ${argv[0]}: application arguments configure a Server; ${why}`);
}
