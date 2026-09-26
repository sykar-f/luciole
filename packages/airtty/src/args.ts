/**
 * `airtty/args`: the command-line arguments of an application, declared once in
 * `app/args.ts` and parsed the same way by every entry point (`airtty dev -- …`,
 * `airtty ./app …`, an app binary, `serve`, `--on`), then again by the Server, which is
 * the authority: one Server holds one set of arguments for its whole life.
 *
 *   export default defineArgs({
 *     summary: "What the app does",
 *     options: z.object({ harness: z.enum(["a", "b"]).meta({ short: "H" }) }).strict(),
 *   });
 *
 * The options are a Standard Schema that also implements Standard JSON Schema (zod 4):
 * the grammar and the help come from its JSON Schema, the values from its `validate`.
 * The framework never reads a schema library's internals.
 *
 * Grammar, per property of the options object (camelCase becomes `--kebab-case`):
 *   boolean                 `--flag`, `--no-flag`
 *   string, enum, number    `--flag value`, `--flag=value` (numbers coerced first)
 *   `true | string`         `--flag` alone, or `--flag value` when the next word is no flag
 *   array of scalars        repeatable: `--flag a --flag b`
 * Metadata (`.meta({...})`): `short` (one letter), `placeholder`, `description`,
 * `kind: "path"` (resolved against the invocation's directory), `env` (a variable read
 * when the flag is absent).
 */
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import * as z from "zod/mini";

/** The Standard Schema interface (standardschema.dev), as far as arguments use it. */
export type StandardSchema<Input = unknown, Output = Input> = {
  readonly "~standard": {
    readonly version: 1;
    readonly vendor: string;
    readonly validate: (value: unknown) => StandardResult<Output> | Promise<StandardResult<Output>>;
    readonly types?: { readonly input: Input; readonly output: Output } | undefined;
  };
};
type StandardResult<Output> =
  | { readonly value: Output; readonly issues?: undefined }
  | {
      readonly issues: readonly {
        readonly message: string;
        readonly path?: readonly (PropertyKey | { readonly key: PropertyKey })[] | undefined;
      }[];
    };
/** Standard JSON Schema: the introspection the grammar and the help are made from. */
export type StandardJsonSchema = {
  readonly "~standard": {
    readonly jsonSchema: {
      readonly input: (options: { readonly target: "draft-2020-12" }) => Record<string, unknown>;
    };
  };
};
/** The options of an application: a Standard Schema with Standard JSON Schema (zod 4). */
export type ArgsSchema<Output = unknown> = StandardSchema<unknown, Output> & StandardJsonSchema;

/**
 * The flags the runtime reads itself, which an application cannot declare: `serve` is a
 * subcommand of app binaries, `--new` skips reattaching a per-launch session.
 */
export const RESERVED_FLAGS: readonly string[] = [
  "url",
  "on",
  "target",
  "grace",
  "yes",
  "help",
  "version",
  "new",
];
export const RESERVED_SHORTS: readonly string[] = ["h"];

/** A command line the application refuses: shown as is, exit code 2 (usage error). */
export class ArgsError extends Error {
  readonly exitCode = 2;
}
export const USAGE_EXIT_CODE = 2;
/**
 * A usage error, whichever copy of this module raised it: a launcher imports the
 * application's bundled copy (`.airtty/args`), whose class is not its own.
 */
export const isUsageError = (error: unknown) =>
  typeof error === "object" &&
  error !== null &&
  "exitCode" in error &&
  error.exitCode === USAGE_EXIT_CODE;

/** One flag of the grammar. */
export type Flag = {
  /** The property of the options object. */
  key: string;
  long: string;
  short?: string;
  /** `switch`: a boolean; `optional`: `true | string`; `list`: repeatable. */
  arity: "switch" | "value" | "optional" | "list";
  type: "string" | "number" | "integer" | "boolean";
  choices?: readonly string[];
  placeholder?: string;
  description?: string;
  default?: unknown;
  required: boolean;
  path: boolean;
  env?: string;
};

// The subset of JSON Schema the grammar reads; anything else is refused by name.
const Scalar = z.enum(["string", "number", "integer", "boolean"]);
const Meta = {
  short: z.optional(z.string().check(z.regex(/^[A-Za-z]$/, "short must be one letter"))),
  placeholder: z.optional(z.string()),
  description: z.optional(z.string()),
  kind: z.optional(z.literal("path")),
  env: z.optional(z.string().check(z.regex(/^[A-Z_][A-Z0-9_]*$/, "env must be a variable name"))),
  default: z.optional(z.unknown()),
};
const Property = z.looseObject({
  ...Meta,
  type: z.optional(z.union([Scalar, z.literal("array")])),
  enum: z.optional(z.array(z.unknown())),
  items: z.optional(
    z.looseObject({ type: z.optional(Scalar), enum: z.optional(z.array(z.unknown())) }),
  ),
  anyOf: z.optional(
    z.array(z.looseObject({ type: z.optional(z.string()), const: z.optional(z.unknown()) })),
  ),
});
const ObjectSchema = z.looseObject({
  type: z.literal("object"),
  properties: z._default(z.record(z.string(), z.unknown()), {}),
  required: z._default(z.array(z.string()), []),
});

const NEGATION = "no-";
const UNSUPPORTED =
  "unsupported schema; use a boolean, a string, an enum, a number, true | string, or an array of those";
const kebab = (key: string) => key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
const texts = (values: readonly unknown[] | undefined) =>
  values?.every((v) => typeof v === "string") ? values.map(String) : undefined;

/** The flags of an options schema, checked: reserved names and unsupported shapes throw. */
export function grammar(schema: StandardJsonSchema): Flag[] {
  const root = ObjectSchema.safeParse(
    schema["~standard"].jsonSchema.input({ target: "draft-2020-12" }),
  );
  if (!root.success) throw new Error("app/args.ts: options must be an object schema");
  const flags: Flag[] = [];
  for (const [key, raw] of Object.entries(root.data.properties)) {
    const long = kebab(key);
    const where = `app/args.ts: --${long}`;
    const parsed = Property.safeParse(raw);
    if (!parsed.success)
      throw new Error(`${where}: ${UNSUPPORTED} (${z.prettifyError(parsed.error)})`);
    const p = parsed.data;
    const base = {
      key,
      long,
      short: p.short,
      placeholder: p.placeholder,
      description: p.description,
      default: p.default,
      required: root.data.required.includes(key),
      path: p.kind === "path",
      env: p.env,
    };
    const optional =
      p.anyOf?.length === 2 &&
      p.anyOf.some((a) => a.const === true) &&
      p.anyOf.some((a) => a.type === "string" && a.const === undefined);
    if (optional) flags.push({ ...base, arity: "optional", type: "string" });
    else if (p.type === "array" && p.items?.type && p.items.type !== "boolean")
      flags.push({ ...base, arity: "list", type: p.items.type, choices: texts(p.items.enum) });
    else if (p.type === "boolean") flags.push({ ...base, arity: "switch", type: "boolean" });
    else if (p.type && p.type !== "array")
      flags.push({ ...base, arity: "value", type: p.type, choices: texts(p.enum) });
    else throw new Error(`${where}: ${UNSUPPORTED}`);
    if (RESERVED_FLAGS.includes(long))
      throw new Error(
        `${where} is reserved by airtty (${RESERVED_FLAGS.map((f) => `--${f}`).join(" ")})`,
      );
    if (p.short && RESERVED_SHORTS.includes(p.short))
      throw new Error(`${where}: -${p.short} is reserved by airtty`);
  }
  for (const [i, flag] of flags.entries()) {
    const twin = flags.slice(i + 1).find((f) => f.short && f.short === flag.short);
    if (twin)
      throw new Error(`app/args.ts: -${flag.short} names both --${flag.long} and --${twin.long}`);
  }
  return flags;
}

/** Edit distance, for "did you mean". */
function distance(a: string, b: string) {
  let row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const next = [i];
    for (let j = 1; j <= b.length; j++)
      next.push(
        Math.min(
          (row[j] ?? 0) + 1,
          (next[j - 1] ?? 0) + 1,
          (row[j - 1] ?? 0) + (a[i - 1] === b[j - 1] ? 0 : 1),
        ),
      );
    row = next;
  }
  return row[b.length] ?? 0;
}
const SUGGEST_DISTANCE = 2;
/** The closest of `known` to `word`, when close enough to be a typo. */
export function suggest(word: string, known: readonly string[]) {
  let best: string | undefined,
    score = SUGGEST_DISTANCE + 1;
  for (const candidate of known) {
    const d = distance(word, candidate);
    if (d < score) [best, score] = [candidate, d];
  }
  return best;
}
const didYouMean = (word: string, known: readonly string[], prefix = "") => {
  const found = suggest(word, known);
  return found ? ` (did you mean ${prefix}${found}?)` : "";
};

export type ParseContext = {
  /** The invocation's directory: `kind: "path"` values are resolved against it. */
  cwd: string;
  /** Read for flags declaring `env`, when absent from the command line. */
  env?: Record<string, string | undefined>;
};

/** Words to the raw values of `flags`, before validation: every usage error named. */
export function tokenize(
  argv: readonly string[],
  flags: readonly Flag[],
  { cwd, env = {} }: ParseContext,
) {
  const raw = new Map<string, unknown>();
  const lists = new Map<string, unknown[]>();
  const byLong = new Map(flags.map((f) => [f.long, f]));
  const byShort = new Map(flags.flatMap((f) => (f.short ? [[f.short, f] as const] : [])));
  const convert = (flag: Flag, text: string): unknown => {
    if (flag.choices && !flag.choices.includes(text))
      throw new ArgsError(
        `--${flag.long}: expected one of ${flag.choices.join("|")}, got "${text}"${didYouMean(text, flag.choices)}`,
      );
    if (flag.type === "number" || flag.type === "integer") {
      const n = Number(text);
      if (text.trim() === "" || Number.isNaN(n))
        throw new ArgsError(`--${flag.long}: expected a number, got "${text}"`);
      return n;
    }
    return flag.path ? resolve(cwd, text) : text;
  };
  const set = (flag: Flag, value: unknown) => {
    if (flag.arity === "list") {
      const list = lists.get(flag.key) ?? [];
      lists.set(flag.key, list);
      list.push(value);
      raw.set(flag.key, list);
    } else if (raw.has(flag.key)) throw new ArgsError(`--${flag.long} is given twice`);
    else raw.set(flag.key, value);
  };
  const needsValue = (flag: Flag) => flag.arity === "value" || flag.arity === "list";
  for (let i = 0; i < argv.length; i++) {
    const word = argv[i] ?? "";
    const next = () => {
      const value = argv[i + 1];
      if (value === undefined) return undefined;
      i++;
      return value;
    };
    if (word === "--") {
      const rest = argv.slice(i + 1);
      if (rest.length)
        throw new ArgsError(`Unexpected argument ${rest[0]}: this app takes options only`);
      break;
    }
    if (word.startsWith("--")) {
      const at = word.indexOf("=");
      const name = at < 0 ? word.slice(2) : word.slice(2, at);
      const inline = at < 0 ? undefined : word.slice(at + 1);
      const negated = name.startsWith(NEGATION)
        ? byLong.get(name.slice(NEGATION.length))
        : undefined;
      if (negated?.arity === "switch" && inline === undefined) {
        set(negated, false);
        continue;
      }
      const flag = byLong.get(name);
      if (!flag)
        throw new ArgsError(
          `Unknown option --${name}${didYouMean(name, [...byLong.keys()], "--")}`,
        );
      if (flag.arity === "switch") {
        if (inline !== undefined)
          throw new ArgsError(`--${flag.long} takes no value (--no-${flag.long} turns it off)`);
        set(flag, true);
      } else if (flag.arity === "optional") {
        const value = inline ?? (argv[i + 1]?.startsWith("-") === false ? next() : undefined);
        set(flag, value === undefined ? true : convert(flag, value));
      } else {
        const value = inline ?? next();
        if (value === undefined) throw new ArgsError(`--${flag.long} needs a value`);
        set(flag, convert(flag, value));
      }
      continue;
    }
    if (word.startsWith("-") && word.length > 1) {
      // `-abc`: switches grouped; a flag taking a value takes the rest, or the next word.
      for (let c = 1; c < word.length; c++) {
        const letter = word[c] ?? "";
        const flag = byShort.get(letter);
        if (!flag) throw new ArgsError(`Unknown option -${letter}`);
        if (flag.arity === "switch") {
          set(flag, true);
          continue;
        }
        const attached = word.slice(c + 1);
        const value =
          attached ||
          (needsValue(flag) || argv[i + 1]?.startsWith("-") === false ? next() : undefined);
        if (value === undefined && needsValue(flag))
          throw new ArgsError(`-${letter} (--${flag.long}) needs a value`);
        set(flag, value === undefined ? true : convert(flag, value));
        break;
      }
      continue;
    }
    throw new ArgsError(`Unexpected argument ${word}: this app takes options only`);
  }
  for (const flag of flags) {
    const text = flag.env ? env[flag.env] : undefined;
    if (raw.has(flag.key) || text === undefined) continue;
    if (flag.arity === "switch") {
      if (!["1", "true", "0", "false", ""].includes(text))
        throw new ArgsError(`${flag.env}: expected 1, true, 0 or false for --${flag.long}`);
      raw.set(flag.key, text === "1" || text === "true");
    } else
      raw.set(
        flag.key,
        flag.arity === "list" ? text.split(",").map((t) => convert(flag, t)) : convert(flag, text),
      );
  }
  for (const flag of flags)
    if (flag.required && !raw.has(flag.key))
      throw new ArgsError(`Missing --${flag.long}${flag.env ? ` (or ${flag.env})` : ""}`);
  return Object.fromEntries(raw);
}

function issuePath(path: readonly (PropertyKey | { readonly key: PropertyKey })[] | undefined) {
  const first = path?.[0];
  return typeof first === "object" ? first.key : first;
}

export type HelpOptions = {
  name: string;
  version?: string;
  /** The runtime's own flags, listed after the application's. */
  runtime?: readonly { flags: string; description: string }[];
  /** `Usage:` lines; `<name> [options]` by default. */
  usage?: readonly string[];
};

const COLUMN_GAP = 2;
/** Two columns, the second aligned. */
function table(rows: readonly (readonly [string, string])[]) {
  const width = Math.max(0, ...rows.map(([left]) => left.length)) + COLUMN_GAP;
  return rows
    .map(([left, right]) => `  ${right ? left.padEnd(width) + right : left}`.trimEnd())
    .join("\n");
}

function flagUsage(flag: Flag) {
  const name = `${flag.short ? `-${flag.short}, ` : "    "}--${flag.long}`;
  const placeholder =
    flag.placeholder ??
    (flag.choices ? flag.choices.join("|") : flag.type === "string" ? "value" : flag.type);
  if (flag.arity === "switch") return name;
  if (flag.arity === "optional") return `${name} [${placeholder}]`;
  return `${name} <${placeholder}>${flag.arity === "list" ? "…" : ""}`;
}
function flagDescription(flag: Flag) {
  const notes = [
    flag.required ? "required" : undefined,
    flag.default !== undefined
      ? `default: ${typeof flag.default === "string" ? flag.default : JSON.stringify(flag.default)}`
      : undefined,
    flag.env ? `env ${flag.env}` : undefined,
    flag.arity === "switch" ? `--no-${flag.long} turns it off` : undefined,
  ].filter((n) => n !== undefined);
  return [flag.description, notes.length ? `(${notes.join(", ")})` : undefined]
    .filter(Boolean)
    .join(" ");
}

export type ArgsSpec<Output> = {
  /** One line, after the name, at the top of `--help`. */
  summary?: string;
  options: ArgsSchema<Output>;
  /** Command lines shown at the end of `--help`. */
  examples?: readonly string[];
};

const ARGS_BRAND = "airtty.args";
export type ArgsDefinition<Output = unknown> = ArgsSpec<Output> & {
  readonly brand: typeof ARGS_BRAND;
  /** The flags, checked. */
  flags(): Flag[];
  /** Parses and validates a command line: an `ArgsError` names what is wrong. */
  parse(argv: readonly string[], context: ParseContext): Promise<Output>;
  /** The generated `--help`: the application's options, then the runtime's. */
  help(options: HelpOptions): string;
  /**
   * The arguments of this Server's launch, parsed at its start: a constant of the process.
   * Only the Server has them; a Client Component receives what it needs as props.
   */
  get(): Output;
  /** The JSON Schema written to `.airtty/metadata.json`. */
  jsonSchema(): Record<string, unknown>;
  /** Parses this Server's launch, once, for `get()` (`configureArgs`). */
  adopt(launch: LaunchArgs, context: ParseContext): Promise<Configured>;
};

/** What a Server's launch was given, once parsed (`configureArgs`). */
type Configured = { value: unknown; argv: readonly string[]; cwd: string; fingerprint: string };
let configured: Configured | undefined;

export function defineArgs<Output>(spec: ArgsSpec<Output>): ArgsDefinition<Output> {
  let flags: Flag[] | undefined;
  let adopted: { value: Output } | undefined;
  const compiled = () => (flags ??= grammar(spec.options));
  const settle = (result: StandardResult<Output>) => {
    if (result.issues) {
      const messages = result.issues.map((issue) => {
        const key = issuePath(issue.path);
        const flag = compiled().find((f) => f.key === key);
        return flag ? `--${flag.long}: ${issue.message}` : issue.message;
      });
      throw new ArgsError(messages.join("\n"));
    }
    return result.value;
  };
  const parse = async (argv: readonly string[], context: ParseContext) =>
    settle(await spec.options["~standard"].validate(tokenize(argv, compiled(), context)));
  const keep = (value: Output, launch: LaunchArgs, cwd: string) => {
    adopted = { value };
    configured = { value, argv: launch.argv, cwd, fingerprint: argsFingerprint(value) };
    return configured;
  };
  const definition: ArgsDefinition<Output> = {
    ...spec,
    brand: ARGS_BRAND,
    flags: compiled,
    parse,
    help({ name, version, runtime = [], usage }) {
      const lines = [
        `${name}${version ? ` ${version}` : ""}${spec.summary ? `: ${spec.summary}` : ""}`,
        "",
      ];
      lines.push("Usage:", ...(usage ?? [`${name} [options]`]).map((u) => `  ${u}`), "");
      const own = compiled();
      if (own.length)
        lines.push("Options:", table(own.map((f) => [flagUsage(f), flagDescription(f)])), "");
      if (runtime.length)
        lines.push("Runtime (airtty):", table(runtime.map((r) => [r.flags, r.description])), "");
      if (spec.examples?.length) lines.push("Examples:", ...spec.examples.map((e) => `  ${e}`), "");
      return lines.join("\n");
    },
    get() {
      if (!adopted)
        throw new Error(
          "Application arguments are read on the Server, once it started; pass what the UI needs as props",
        );
      return adopted.value;
    },
    jsonSchema: () => spec.options["~standard"].jsonSchema.input({ target: "draft-2020-12" }),
    async adopt(launch, context) {
      return configured ?? keep(await parse(launch.argv, context), launch, context.cwd);
    },
  };
  // In a Server, parsed as the module is defined: `get()` works at module level, where
  // the modules importing this one read it before the entry's own code runs.
  const server = serverLaunch();
  if (server)
    try {
      const launch = decodeLaunchArgs(server.env[ARGS_VARIABLE]);
      const cwd = launch.cwd ?? server.cwd;
      const result = spec.options["~standard"].validate(
        tokenize(launch.argv, compiled(), { cwd, env: server.env }),
      );
      if (result instanceof Promise)
        throw new Error("app/args.ts: an asynchronous schema cannot configure a Server");
      keep(settle(result), launch, cwd);
    } catch (error: unknown) {
      refuse(error);
    }
  return definition;
}

/** A Server that cannot start with the arguments it was given: exit code 2, and why. */
function refuse(error: unknown): never {
  console.error(
    `Invalid application arguments: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exit(USAGE_EXIT_CODE);
}

// Set by the Server entry before any application module is evaluated (src/args-server.ts).
const SERVER_LAUNCH = Symbol.for("airtty.args.server");
const ServerLaunch = z.object({
  env: z.record(z.string(), z.optional(z.string())),
  cwd: z.string(),
});
/** Marks this process as a Server: definitions evaluated from now on adopt its launch. */
export function markServer(env: Record<string, string | undefined>, cwd: string) {
  Reflect.set(globalThis, SERVER_LAUNCH, { env, cwd });
}
function serverLaunch() {
  const parsed = ServerLaunch.safeParse(Reflect.get(globalThis, SERVER_LAUNCH));
  return parsed.success ? parsed.data : undefined;
}

/** `app/args.ts`'s default export, as a launcher imports it from a built bundle. */
export function isArgsDefinition(value: unknown): value is ArgsDefinition {
  return (
    typeof value === "object" &&
    value !== null &&
    "brand" in value &&
    value.brand === ARGS_BRAND &&
    "parse" in value &&
    typeof value.parse === "function" &&
    "help" in value &&
    typeof value.help === "function"
  );
}

const FINGERPRINT_LENGTH = 16;
/** Keys sorted at every level: equal values, equal text. */
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (typeof value === "object" && value !== null)
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, v]) => v !== undefined)
        .sort(([a], [b]) => (a < b ? -1 : 1))
        .map(([k, v]) => [k, canonical(v)]),
    );
  return value;
}
/** Identifies a set of parsed arguments: part of a Server's key (src/launcher/launch-key.ts). */
export const argsFingerprint = (value: unknown) =>
  createHash("sha256")
    .update(JSON.stringify(canonical(value)))
    .digest("hex")
    .slice(0, FINGERPRINT_LENGTH);

/**
 * How a launch hands its arguments to its Server: an environment variable, never the
 * command line, which `ps` shows other users. `cwd` is where the user typed the command.
 */
export const LaunchArgs = z.object({
  v: z.literal(1),
  argv: z.array(z.string()),
  cwd: z.optional(z.string()),
});
export type LaunchArgs = z.infer<typeof LaunchArgs>;
export const ARGS_VARIABLE = "AIRTTY_ARGS";
export const encodeLaunchArgs = (argv: readonly string[], cwd?: string) =>
  JSON.stringify({
    v: 1,
    argv: [...argv],
    ...(cwd === undefined ? {} : { cwd }),
  } satisfies LaunchArgs);
export function decodeLaunchArgs(text: string | undefined): LaunchArgs {
  if (text === undefined) return { v: 1, argv: [] };
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new ArgsError(`${ARGS_VARIABLE} is not JSON`);
  }
  const parsed = LaunchArgs.safeParse(value);
  if (!parsed.success) throw new ArgsError(`${ARGS_VARIABLE}: ${z.prettifyError(parsed.error)}`);
  return parsed.data;
}

/**
 * The Server's own parse, before it serves: the launcher's was a check, this one is the
 * value `get()` returns. A command line it refuses ends the process with exit code 2.
 */
export async function configureArgs(
  definition: ArgsDefinition,
  env: Record<string, string | undefined>,
  cwd: string,
) {
  try {
    const launch = decodeLaunchArgs(env[ARGS_VARIABLE]);
    await definition.adopt(launch, { cwd: launch.cwd ?? cwd, env });
  } catch (error: unknown) {
    refuse(error);
  }
}

/** This Server's arguments, `undefined` when the application declares none. */
export const configuredArgs = (): Readonly<Configured> | undefined => configured;
