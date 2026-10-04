import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";

// The code of the libraries' READMEs, the pages npm shows. The first `tsx` block is the
// package's standalone program, character for character, which `bun run check`
// type-checks and the site's capture runs. Every other `ts` or `tsx` block is an example
// of the API: each one type-checks as a module of its own, against the package's sources.
const root = join(import.meta.dir, "..");

const libraries = [
  { dir: "packages/flow-graph", program: "example/main.tsx" },
  { dir: "packages/markdown-editor", program: "example/index.tsx" },
];

interface Block {
  lang: string;
  code: string;
  /** The block's first line of code in the README, from 1. */
  line: number;
}

/** The fenced blocks of a Markdown page, with their language and first line. */
export function codeBlocks(markdown: string): Block[] {
  const blocks: Block[] = [];
  let open: { lang: string; line: number; lines: string[] } | null = null;
  markdown.split("\n").forEach((text, index) => {
    if (!open) {
      const fence = /^```(\w*)\s*$/.exec(text);
      if (fence) open = { lang: fence[1] ?? "", line: index + 2, lines: [] };
    } else if (/^```\s*$/.test(text)) {
      blocks.push({ lang: open.lang, line: open.line, code: `${open.lines.join("\n")}\n` });
      open = null;
    } else open.lines.push(text);
  });
  return blocks;
}

const readmeOf = (dir: string) => readFileSync(join(root, dir, "README.md"), "utf8");
const isCode = (block: Block) => block.lang === "ts" || block.lang === "tsx";

describe.each(libraries)("$dir/README.md", ({ dir, program }) => {
  const blocks = codeBlocks(readmeOf(dir));

  test(`opens with ${program}, the standalone program`, () => {
    const first = blocks.find((block) => block.lang === "tsx");
    expect(first?.code).toBe(readFileSync(join(root, dir, program), "utf8"));
  });

  test("shows examples of its API", () => {
    expect(blocks.filter(isCode).length).toBeGreaterThan(1);
  });
});

// The examples are checked where `node_modules` resolves the packages and their peers, with
// the compiler options of the programs in `example/`: JSX for OpenTUI, and the `bun`
// condition that points the packages to their sources.
const cache = join(root, "node_modules/.cache");
mkdirSync(cache, { recursive: true });
const workdir = mkdtempSync(join(cache, "readme-examples-"));
afterAll(() => rmSync(workdir, { recursive: true, force: true }));

const compilerOptions = {
  target: "ESNext",
  module: "ESNext",
  moduleResolution: "Bundler",
  jsx: "react-jsx",
  jsxImportSource: "@opentui/react",
  customConditions: ["bun"],
  allowImportingTsExtensions: true,
  strict: true,
  verbatimModuleSyntax: true,
  skipLibCheck: true,
  noEmit: true,
  types: [],
  moduleDetection: "force",
};

test("every example of the READMEs type-checks", () => {
  // Each example is a file named after its README line, to point an error back to it.
  const origin = new Map<string, string>();
  for (const { dir, program } of libraries) {
    const examples = codeBlocks(readmeOf(dir)).filter(isCode);
    const programBlock = examples.find((block) => block.lang === "tsx");
    for (const block of examples) {
      if (block === programBlock && block.code === readFileSync(join(root, dir, program), "utf8"))
        continue;
      const file = `${basename(dir)}-${block.line}.${block.lang}`;
      writeFileSync(join(workdir, file), block.code);
      origin.set(file, `${dir}/README.md:${block.line}`);
    }
  }
  expect(origin.size).toBeGreaterThan(0);
  writeFileSync(join(workdir, "tsconfig.json"), JSON.stringify({ compilerOptions }));

  const tsc = join(dirname(Bun.resolveSync("typescript/package.json", root)), "bin/tsc");
  const run = Bun.spawnSync([process.execPath, tsc, "-p", workdir, "--pretty", "false"]);
  // `file(line,col): error`, with the line counted from the README's block.
  const errors = `${run.stdout.toString()}${run.stderr.toString()}`
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) =>
      line.replace(/^(?:.*\/)?([\w-]+\.tsx?)\((\d+),(\d+)\)/, (whole, file: string, at: string) => {
        const start = origin.get(file)?.split(":");
        return start ? `${start[0]}:${Number(start[1]) + Number(at) - 1}` : whole;
      }),
    );
  expect(errors).toEqual([]);
  expect(run.exitCode).toBe(0);
});
