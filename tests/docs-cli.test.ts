import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { commands, fallback } from "../packages/core/src/commands";
import type { Command } from "../packages/core/src/commands/command";

// The CLI reference against the commands themselves: every subcommand has its entry in
// cli.mdx, and its entry names every flag the command declares (commands/command.ts).
const PAGE = join(import.meta.dir, "../website/src/content/docs/reference/cli.mdx");

/** What `luciole <name>` runs, by the name its entry gives it; the fallback is `<target>`. */
const documented: ReadonlyMap<string, Command> = new Map([...commands, ["<target>", fallback]]);

/** The entries of the page: each heading with its section, and each table row on its own. */
function entries(page: string) {
  const lines = page.split("\n");
  const found: string[] = [];
  lines.forEach((line, i) => {
    if (/^#{2,4} /.test(line)) {
      const next = lines.findIndex((other, j) => j > i && /^#{2,4} /.test(other));
      found.push(lines.slice(i, next < 0 ? undefined : next).join("\n"));
    } else if (line.startsWith("| `luciole ")) found.push(line);
  });
  return found;
}

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** Whether `text` names `flag` as a word: `--web` is not named by `--web-local`. */
const names = (text: string, flag: string) =>
  new RegExp(`(?<![\\w-])${escape(flag)}(?![\\w-])`).test(text);

/** What the page leaves out: a subcommand without an entry, a flag missing from its entry. */
function undocumented(page: string, all: ReadonlyMap<string, Command> = documented) {
  const problems: string[] = [];
  const sections = entries(page);
  for (const [name, command] of all) {
    const heading = new RegExp(`\`luciole ${escape(name)}[ \`]`);
    const entry = sections.find((each) => heading.test(each.split("\n")[0] ?? ""));
    if (!entry) {
      problems.push(`luciole ${name}: no entry`);
      continue;
    }
    for (const flag of Object.keys(command.flags))
      if (!names(entry, flag)) problems.push(`luciole ${name}: ${flag} missing`);
  }
  return problems;
}

const page = readFileSync(PAGE, "utf8");

test("cli.mdx has an entry for every subcommand, naming every flag it declares", () => {
  expect(undocumented(page)).toEqual([]);
});

test("the check fails on a flag or a subcommand the page leaves out", () => {
  expect(undocumented(page.replaceAll("--web-local", "--web"))).toContain(
    "luciole build: --web-local missing",
  );
  expect(undocumented(page.replace("### `luciole runtime", "### `luciole other"))).toContain(
    "luciole runtime: no entry",
  );
});
