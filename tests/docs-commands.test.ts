import { expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { runCommands } from "../website/src/lib/example-commands";
import { commands, envPrefix, packages } from "../website/src/lib/product";

const root = join(import.meta.dir, "..");

const Manifest = z.looseObject({ name: z.string(), private: z.boolean().optional() });

/** The packages a release publishes: those of packages/* not marked private (docs/RELEASING.md). */
const publishedPackages = readdirSync(join(root, "packages"), { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => join("packages", entry.name))
  .filter((directory) => existsSync(join(root, directory, "package.json")))
  .map((directory) => ({
    directory,
    manifest: Manifest.parse(
      JSON.parse(readFileSync(join(root, directory, "package.json"), "utf8")),
    ),
  }))
  .filter(({ manifest }) => manifest.private === false);
const published = publishedPackages.map(({ manifest }) => manifest.name);

/** `name` of `name@version`, scoped or not. */
const packageName = (spec: string) => spec.replace(/(?<=.)@[^/]*$/, "");

/** What `bun <word>` runs that is neither a file nor a script: Bun's own subcommands. */
const BUN_SUBCOMMANDS = new Set(
  "a add audit build exec i info init install link outdated patch pm publish remove repl rm test unlink update upgrade why".split(
    " ",
  ),
);

/** A token the reader replaces, such as `<script>` or `test:pty:<name>`; its fixed prefix. */
const placeholder = (token: string) => /^([^<…]*)[<…]/.exec(token)?.[1];

/**
 * Where a printed command runs, and so what it may name there: the scripts of the
 * `package.json` it runs next to, and the files that exist beside it. A place left undefined
 * means the page does not say where the command runs.
 */
export interface Place {
  exists?: (path: string) => boolean;
  scripts?: readonly string[];
  ours: readonly string[];
}

/** The package `bun create <template>` fetches, as Bun resolves it. */
const createPackage = (template: string) =>
  template.startsWith("@")
    ? template.includes("/")
      ? template.replace("/", "/create-")
      : `${template}/create`
    : `create-${template}`;

/**
 * What stops a printed command from running as written: `bun <file>` naming a file its place
 * lacks, `bun run <script>` naming a script its place lacks, or `bunx <package>` and
 * `bun create <template>` fetching a package that is not ours.
 */
export function commandProblem(command: string, place: Place): string | undefined {
  const words = command
    .trim()
    .replace(/^(\w+=\S*\s+)+/, "")
    .split(/\s+/)
    .map((word, index, all) => (index === all.length - 1 ? word.replace(/[.,;:]+$/, "") : word));
  const [program = "", ...rest] = words;
  const args = rest.filter((word) => !word.startsWith("-"));
  const notOurs = (name: string) =>
    place.ours.includes(name)
      ? undefined
      : `${command}: ${name} is not one of our packages (${place.ours.join(", ")})`;
  const missingFile = (path: string) => {
    if (!place.exists) return `${command}: the page does not say where it runs (PAGE_PLACES)`;
    return place.exists(path) ? undefined : `${command}: ${path} does not exist`;
  };
  if (program === "bunx") return args[0] ? notOurs(packageName(args[0])) : undefined;
  if (program !== "bun") return undefined;
  const [verb = "", target] = args;
  if (verb === "x") return target ? notOurs(packageName(target)) : undefined;
  if (verb === "create")
    return target && placeholder(target) === undefined ? notOurs(createPackage(target)) : undefined;
  if (BUN_SUBCOMMANDS.has(verb) || !/^[\w.@/:<…-]+$/.test(verb)) return undefined;
  if (verb !== "run") return /[/.]/.test(verb) ? missingFile(verb) : undefined;
  if (!target) return undefined;
  if (/[/]|\.[cm]?[jt]sx?$/.test(target)) return missingFile(target);
  const prefix = placeholder(target);
  if (prefix === "") return undefined;
  if (!place.scripts) return `${command}: the page does not say where it runs (PAGE_PLACES)`;
  const found =
    prefix === undefined
      ? place.scripts.includes(target)
      : place.scripts.some((script) => script.startsWith(prefix));
  return found ? undefined : `${command}: no script "${target}" where it runs`;
}

const Scripts = z.looseObject({ scripts: z.record(z.string(), z.string()) });
const scriptsOf = (manifest: string) =>
  Object.keys(Scripts.parse(JSON.parse(readFileSync(join(root, manifest), "utf8"))).scripts);

/** The scripts `luciole init` writes in a starter's `package.json`, read from its source. */
function starterScripts(): string[] {
  const source = readFileSync(join(root, "packages/create/scripts/starter.ts"), "utf8");
  const block = /\n(\s*)scripts: \{\n([\s\S]*?)\n\1\}/.exec(source)?.[2] ?? "";
  return [...block.matchAll(/^\s*"?([\w:-]+)"?: "/gm)].map((match) => match[1] ?? "");
}

/**
 * What a starter's build writes that a page may run, with where the framework itself starts
 * it: the page and the launcher must agree on the path.
 */
const BUILD_OUTPUTS = { ".luciole/server/index.js": "packages/core/src/launcher/index.ts" };

/** The places a printed command can run, each with what it may name. */
const places = {
  /** The root of a clone of the repository: contributor commands. */
  repository: {
    exists: (path: string) => existsSync(join(root, path)),
    scripts: scriptsOf("package.json"),
    ours: published,
  },
  /** An app `luciole init` created: Notes' files, its config files, its build. */
  starter: {
    exists: (path: string) =>
      path in BUILD_OUTPUTS || existsSync(join(root, "examples/notes", path)),
    scripts: starterScripts(),
    ours: published,
  },
  /** The site's own directory, `website/`. */
  website: {
    exists: (path: string) => existsSync(join(root, "website", path)),
    scripts: scriptsOf("website/package.json"),
    ours: published,
  },
  /**
   * The reader's own project, for a library's README: no script of ours, and only the files
   * the page asks to save (`Save this program as \`main.tsx\``).
   */
  project: { scripts: [], ours: published },
} satisfies Record<string, Place>;
type PlaceName = keyof typeof places;

const inRepository: Place = places.repository;

test("a release publishes the five packages the documentation can name", () => {
  expect(published.toSorted()).toEqual([
    "@luciole-sh/core",
    "@luciole-sh/create",
    "@luciole-sh/flow-graph",
    "@luciole-sh/markdown-editor",
    "luciole.sh",
  ]);
});

test("the check refuses a missing file and a package that is not ours", () => {
  expect(commandProblem("bun packages/luciole/src/cli.ts", inRepository)).toContain(
    "does not exist",
  );
  expect(commandProblem("bunx luciole init my-app", inRepository)).toContain("not one of our");
  expect(commandProblem("bunx create-luciole", inRepository)).toContain("not one of our");
  expect(commandProblem("bunx @luciole-sh/create@0.1.0 my-app", inRepository)).toBeUndefined();
  expect(commandProblem("bun run dev", inRepository)).toBeUndefined();
  expect(commandProblem("luciole", inRepository)).toBeUndefined();
});

test("every command the site prints runs a file that exists or a package of ours", () => {
  const problems = Object.values(commands)
    .map((command) => commandProblem(command, inRepository))
    .filter(Boolean);
  expect(problems).toEqual([]);
});

test("every package the site names is published", () => {
  expect(Object.values(packages).filter((name) => !published.includes(name))).toEqual([]);
});

const examplesOnSite = Object.entries(runCommands).map(([key, example]) => ({ key, example }));

/** The example a `luciole example <name>` command runs, if it is one: `[ENV=… ]luciole example <name> …`. */
const exampleNamed = (command: string) => /\bluciole example (\S+)/.exec(command)?.[1];

test("every example the site runs with `luciole example` is a directory of examples/", () => {
  const named = examplesOnSite
    .map(({ example }) => exampleNamed(example.command))
    .filter((name) => name !== undefined);
  expect(named.length).toBeGreaterThan(0);
  expect(named.filter((name) => !existsSync(join(root, "examples", name)))).toEqual([]);
});

test("every example the site lists runs from a clone: a script of the root or a file", () => {
  const problems = examplesOnSite.flatMap(({ key, example }) => {
    const problem = commandProblem(example.fromClone, inRepository);
    return problem ? [`${key}: ${problem}`] : [];
  });
  expect(problems).toEqual([]);
});

test("the README lists the examples of the site, but Forge", () => {
  const readme = readFileSync(join(root, "README.md"), "utf8");
  const section = readme.slice(
    readme.indexOf("## Run an example"),
    readme.indexOf("## Read the documentation"),
  );
  const documented = [...section.matchAll(/^\| (?:`(\w+)`|DevTools)\s+\| `/gm)].map(
    (m) => m[1] ?? "devtools",
  );
  const onSite = examplesOnSite.map(({ key }) => key).filter((key) => key !== "forge");
  expect([...new Set(documented)].toSorted()).toEqual(onSite.toSorted());
  expect(readme).not.toMatch(/forge/i);
});

/** Fence languages whose lines a reader types; other fences hold source code or output. */
const SHELL_FENCES = new Set(["", "sh", "bash", "shell", "console", "zsh"]);

/** The values pages interpolate into commands (`${commands.fromNpm} init my-app`). */
const interpolated: Record<string, string> = {
  ...Object.fromEntries(Object.entries(commands).map(([key, value]) => [`commands.${key}`, value])),
  envPrefix,
};

/** A command a page prints, with its line and the headings of the sections it is in. */
export interface Printed {
  line: number;
  command: string;
  headings: string[];
  /** Where the command runs whatever its page, for a command of `src/lib/product.ts`. */
  runsIn?: PlaceName;
}

/**
 * The `bun` and `bunx` commands a Markdown, MDX or Astro page prints: in its text, its code
 * spans, its shell fences and the strings of its components, after the interpolations of
 * `src/lib/product.ts` and the HTML entities. Fences of source code or output are skipped: a
 * command written inside a program's string is not one the reader types.
 */
export function commandsIn(text: string): Printed[] {
  const printed: Printed[] = [];
  let fence: string | undefined;
  const headings: string[] = [];
  for (const [index, raw] of text.split("\n").entries()) {
    const marker = /^\s*(```+|~~~+)\s*([\w-]*)/.exec(raw);
    if (marker) {
      fence = fence === undefined ? (marker[2] ?? "") : undefined;
      continue;
    }
    if (fence !== undefined && !SHELL_FENCES.has(fence)) continue;
    const level = fence === undefined ? (/^(#{1,6}) /.exec(raw)?.[1]?.length ?? 0) : 0;
    if (level > 0) {
      while ((/^#+/.exec(headings.at(-1) ?? "")?.[0].length ?? 0) >= level) headings.pop();
      headings.push(raw.trim());
    }
    const line = raw
      .replace(
        /\$?\{(commands\.\w+|envPrefix)\}/g,
        (whole, key: string) => interpolated[key] ?? whole,
      )
      .replace(/<\/?[a-z][a-z0-9]*(\s[^<>{}]*)?\/?>/g, "|")
      .replaceAll("&lt;", "<")
      .replaceAll("&gt;", ">")
      .replaceAll("&quot;", '"')
      .replaceAll("&amp;", "&");
    const cd = /\binit\s+([\w./-]+)[\s\S]*?\bcd\s+([\w./-]+)/.exec(line);
    const intoStarter = cd && cd[1] === cd[2] ? cd.index + cd[0].length : undefined;
    // A command ends at the end of its code span, string or tag, at a shell operator or
    // comment, or at the end of a sentence (`after bun run dev. On the right…`).
    for (const match of line.matchAll(/(?<![\w./@-])bunx?\s+[^`"'|;(){}#\n]*/g)) {
      const command = match[0].split(/&&|[.,:](?:\s|$)/)[0]?.trim() ?? "";
      if (!/^bunx?\s+\S/.test(command)) continue;
      // `${commands.fromClone}` is the CLI of a clone: it runs at the root of the repository,
      // whatever the page around it.
      const fromClone =
        raw.includes("commands.fromClone") && command.startsWith(commands.fromClone);
      // After `init <dir>` and `cd <dir>` on one line, the commands run in the new starter.
      const inStarter = intoStarter !== undefined && (match.index ?? 0) > intoStarter;
      const runsIn = fromClone ? "repository" : inStarter ? "starter" : undefined;
      printed.push({
        line: index + 1,
        command,
        headings: [...headings],
        ...(runsIn && { runsIn }),
      });
    }
  }
  return printed;
}

/** The pages and READMEs whose commands a reader runs: the public scope of the site. */
const corpus = [
  ...[...new Bun.Glob("**/*.{md,mdx,astro}").scanSync(join(root, "website/src"))]
    .map((path) => join("website/src", path))
    // The French guide leaves the public site once its content is ported (decisions.md).
    .filter((path) => !path.startsWith("website/src/pages/guide/")),
  "README.md",
  ...publishedPackages
    .map(({ directory }) => join(directory, "README.md"))
    .filter((path) => existsSync(join(root, path))),
].toSorted();

/**
 * Where each page's commands run, when one of them names a script or a file: the page's place,
 * and the sections, by their heading, that run elsewhere. A section ends at the next heading
 * of its level or above. The prose next to each command says the same: "From the repository's
 * root", "In a starter", "From the app's directory", "Save this program as `main.tsx`".
 */
const PAGE_PLACES: Record<
  string,
  {
    page: PlaceName;
    sections?: Record<string, PlaceName>;
    /** Commands whose own sentence says where they run, by their text. */
    commands?: Record<string, PlaceName>;
  }
> = {
  "README.md": { page: "repository", sections: { "### Create an app": "starter" } },
  "packages/create/README.md": { page: "starter" },
  "packages/flow-graph/README.md": {
    page: "project",
    sections: { "### Run the example from a clone": "repository" },
  },
  "packages/markdown-editor/README.md": {
    page: "project",
    sections: { "### Run the example from a clone": "repository" },
  },
  "website/src/components/Start.astro": { page: "starter" },
  "website/src/components/docs/Search.astro": { page: "website" },
  "website/src/content/docs/concepts/cache.mdx": { page: "starter" },
  "website/src/content/docs/getting-started.mdx": {
    page: "starter",
    sections: { "## How do you run luciole from a clone?": "repository" },
  },
  "website/src/content/docs/guides/devtools.mdx": { page: "repository" },
  "website/src/content/docs/guides/latency-and-faults.mdx": { page: "starter" },
  "website/src/content/docs/guides/opening-an-app.mdx": {
    page: "repository",
    sections: { "### Serve the app from your Server": "starter" },
  },
  "website/src/content/docs/guides/terminals-and-panes.mdx": { page: "repository" },
  "website/src/content/docs/guides/testing.mdx": {
    page: "starter",
    sections: {
      "## Script a journey in a real terminal": "repository",
      "## What the repository proves, and what it does not": "repository",
    },
  },
  "website/src/content/docs/reference/build-and-distribution.mdx": {
    page: "starter",
    // "In a clone of the repository, `bun run test:linux` runs these variants…"
    commands: { "bun run test:linux": "repository" },
  },
  "website/src/content/docs/reference/cli.mdx": { page: "starter" },
  "website/src/content/docs/reference/releases.mdx": { page: "starter" },
  "website/src/content/docs/reference/troubleshooting.mdx": { page: "starter" },
  "website/src/pages/lab/mascot.astro": { page: "starter" },
  "website/src/pages/status.astro": { page: "repository" },
};

/** The place a command runs in, from its page and its sections; none when the page says nothing. */
function placeOf(path: string, text: string, { command, headings, runsIn }: Printed): Place {
  if (runsIn && runsIn !== "project") return places[runsIn];
  const declared = PAGE_PLACES[path];
  if (!declared) return { ours: published };
  const section = headings.findLast((heading) => declared.sections?.[heading] !== undefined);
  const place =
    declared.commands?.[command] ?? ((section && declared.sections?.[section]) || declared.page);
  if (place !== "project") return places[place];
  return { ...places.project, exists: (file) => text.includes(`as \`${file}\``) };
}

const printedOnSite = corpus.flatMap((path) => {
  const text = readFileSync(join(root, path), "utf8");
  return commandsIn(text).map((printed) => ({ path, text, ...printed }));
});

test("a page's commands are read from its text, code, shell fences and component strings", () => {
  const page = [
    "## Install",
    "Run <code>bun run test:pty:&lt;name&gt;</code>, then `bun run dev`.",
    '<CopyCommand lines={[`${commands.fromNpm} init my-app`, "cd my-app && bun install"]} />',
    "```tsx",
    "const note = `Run bun run build when you are back.`;",
    "```",
    "### From a clone",
    "```sh",
    "LUCIOLE_LATENCY_MS=500 bun run dev   # slower",
    "```",
    "## Next",
    'eval "$(bun packages/core/src/cli.ts devtools --env)"',
  ].join("\n");
  expect(commandsIn(page)).toEqual([
    { line: 2, command: "bun run test:pty:<name>", headings: ["## Install"] },
    { line: 2, command: "bun run dev", headings: ["## Install"] },
    { line: 3, command: "bunx luciole.sh init my-app", headings: ["## Install"] },
    { line: 3, command: "bun install", headings: ["## Install"], runsIn: "starter" },
    { line: 9, command: "bun run dev", headings: ["## Install", "### From a clone"] },
    { line: 12, command: "bun packages/core/src/cli.ts devtools --env", headings: ["## Next"] },
  ]);
  const clone =
    '<CopyCommand lines={[`${commands.fromClone} init ../app`, "cd ../app", "bun run dev"]} />';
  expect(commandsIn(clone).map(({ command, runsIn }) => ({ command, runsIn }))).toEqual([
    { command: "bun packages/core/src/cli.ts init ../app", runsIn: "repository" },
    { command: "bun run dev", runsIn: "starter" },
  ]);
});

test("the check refuses a script its place lacks, and a page that does not say where", () => {
  const { starter, repository, website } = places;
  expect(commandProblem("bun run verify", starter)).toBeUndefined();
  expect(commandProblem("bun run mux", starter)).toContain('no script "mux"');
  expect(commandProblem("bun run mux", repository)).toBeUndefined();
  expect(commandProblem("bun run test:pty:<name>", repository)).toBeUndefined();
  expect(commandProblem("bun run test:nothing:<name>", repository)).toContain("no script");
  expect(commandProblem("bun run build", website)).toBeUndefined();
  expect(commandProblem("bun run <script>", starter)).toBeUndefined();
  expect(commandProblem("bun --conditions=react-server .luciole/server/index.js", starter)).toBe(
    undefined,
  );
  expect(commandProblem("bun create @luciole-sh my-app", starter)).toBeUndefined();
  expect(commandProblem("bun create luciole my-app", starter)).toContain("not one of our");
  expect(commandProblem("bun run dev", { ours: published })).toContain("does not say where");
  expect(commandProblem("bun install --frozen-lockfile", { ours: published })).toBeUndefined();
});

test("a starter's scripts are read from the source that writes them", () => {
  for (const script of ["dev", "build", "verify"]) expect(places.starter.scripts).toContain(script);
  expect(places.starter.scripts).not.toContain("mux");
});

test("the build outputs a page runs are the paths the launcher starts", () => {
  for (const [output, starter] of Object.entries(BUILD_OUTPUTS))
    expect(readFileSync(join(root, starter), "utf8")).toContain(output);
});

test("every page whose place is declared is in the public scope", () => {
  expect(Object.keys(PAGE_PLACES).filter((path) => !corpus.includes(path))).toEqual([]);
});

test("every command the public pages print runs where the page says to run it", () => {
  expect(printedOnSite.length).toBeGreaterThan(50);
  const problems = printedOnSite
    .map(({ path, text, ...printed }) => {
      const problem = commandProblem(printed.command, placeOf(path, text, printed));
      return problem && `${path}:${printed.line}: ${problem}`;
    })
    .filter(Boolean);
  expect(problems).toEqual([]);
});
