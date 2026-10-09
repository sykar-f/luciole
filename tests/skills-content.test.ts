import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { z } from "zod";
import { build } from "../scripts/pack-docs";

/**
 * The rules every skill of `packages/core/skills/` and the `AGENTS.md` block follow: the Agent
 * Skills specification's limits, links that stay inside a skill, and docs pointers that name a
 * page the package really ships. Each failure reads `<skill>: <file>: <rule>: <detail>`.
 */

const workspace = resolve(import.meta.dir, "..");
const SKILLS = join(workspace, "packages/core/skills");
const BLOCK = join(workspace, "packages/core/agents-block.md");

/** The Agent Skills spec's fields, and `disable-model-invocation` (Claude Code, Cursor). */
const FIELDS = new Set([
  "name",
  "description",
  "license",
  "compatibility",
  "metadata",
  "allowed-tools",
  "disable-model-invocation",
]);
const NAME = /^luciole-[a-z0-9-]+$/;
const NAME_MAX = 64;
const DESCRIPTION_MAX = 1024;
const BODY_MAX_LINES = 500;
const BLOCK_MAX_BYTES = 8 * 1024;
const BLOCK_LABEL = "agents-block";
const DOCS_POINTER = /node_modules\/@luciole-sh\/core\/docs\/([\w./-]+?\.md)/g;
// An inline Markdown link or image: its target, up to a space (a title) or the closing paren.
const LINK = /!?\[[^\]]*\]\(\s*<?([^)\s>]+)>?(?:\s+["'(][^)]*)?\)/g;
// A link reference definition, `[label]: target "title"`, which `[text][label]` links use.
const DEFINITION = /^ {0,3}\[[^\]]+\]:\s*<?([^\s>]+)>?/gm;
const EXTERNAL = /^([a-z][a-z0-9+.-]*:|\/\/|#)/i;

const Frontmatter = z.record(z.string(), z.unknown());
const OpenAiYaml = z.looseObject({
  policy: z.looseObject({ allow_implicit_invocation: z.unknown() }).optional(),
});

type Split =
  | { ok: true; fields: Record<string, unknown>; body: string }
  | { ok: false; error: string };

/** `SKILL.md`'s frontmatter and body, or why it has none. */
function splitSkill(text: string): Split {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
  if (!match) return { ok: false, error: "no YAML frontmatter between --- lines" };
  let parsed: unknown;
  try {
    parsed = Bun.YAML.parse(match[1] ?? "");
  } catch (error: unknown) {
    return { ok: false, error: `invalid YAML: ${String(error)}` };
  }
  const fields = Frontmatter.safeParse(parsed);
  if (!fields.success) return { ok: false, error: "the frontmatter is not a mapping" };
  return { ok: true, fields: fields.data, body: match[2] ?? "" };
}

async function filesUnder(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { recursive: true, withFileTypes: true }).catch(
    () => [],
  );
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => relative(directory, join(entry.parentPath, entry.name)))
    .toSorted();
}

/** The relative link targets of a Markdown text, without their fragment. */
function relativeLinks(markdown: string) {
  return [...markdown.matchAll(LINK), ...markdown.matchAll(DEFINITION)]
    .map((match) => match[1] ?? "")
    .filter((target) => target && !EXTERNAL.test(target))
    .map((target) => decodeURI(target.replace(/[#?].*$/, "")))
    .filter(Boolean);
}

function docsPointers(text: string) {
  return [...text.matchAll(DOCS_POINTER)].map((match) => match[1] ?? "");
}

/** Every rule's failures over a skills directory and a block, given the docs pages produced. */
async function lint(skills: string, block: string, pages: ReadonlySet<string>) {
  const failures: string[] = [];
  const fail = (skill: string, file: string, rule: string, detail: string) =>
    failures.push(`${skill}: ${file}: ${rule}: ${detail}`);
  const checkPointers = (skill: string, file: string, text: string) => {
    for (const page of docsPointers(text))
      if (!pages.has(page)) fail(skill, file, "docs-pointer", `docs/${page} is not a docs page`);
  };

  const entries = await readdir(skills, { withFileTypes: true });
  const folders = entries.filter((e) => e.isDirectory()).map((e) => e.name);
  for (const skill of folders.toSorted()) {
    const folder = join(skills, skill);
    const files = await filesUnder(folder);
    const skillText = await readFile(join(folder, "SKILL.md"), "utf8").catch(() => undefined);
    if (skillText === undefined) {
      fail(skill, "SKILL.md", "skill-file", "missing");
      continue;
    }
    const split = splitSkill(skillText);
    if (!split.ok) {
      fail(skill, "SKILL.md", "frontmatter", split.error);
      continue;
    }
    const { fields, body } = split;
    for (const key of Object.keys(fields))
      if (!FIELDS.has(key)) fail(skill, "SKILL.md", "frontmatter-fields", `unknown field ${key}`);

    const name = fields["name"];
    if (typeof name !== "string") fail(skill, "SKILL.md", "name", "missing or not a string");
    else {
      if (name !== skill) fail(skill, "SKILL.md", "name", `${name} is not the folder's name`);
      if (!NAME.test(name)) fail(skill, "SKILL.md", "name", `${name} does not match ${NAME}`);
      if (name.length > NAME_MAX)
        fail(skill, "SKILL.md", "name", `${name.length} characters, at most ${NAME_MAX}`);
    }

    const description = fields["description"];
    if (typeof description !== "string" || !description.trim())
      fail(skill, "SKILL.md", "description", "missing or empty");
    else if (description.length > DESCRIPTION_MAX)
      fail(
        skill,
        "SKILL.md",
        "description",
        `${description.length} characters, at most ${DESCRIPTION_MAX}`,
      );

    const lines = body.split("\n").length - (body.endsWith("\n") ? 1 : 0);
    if (lines > BODY_MAX_LINES)
      fail(skill, "SKILL.md", "body-length", `${lines} lines, at most ${BODY_MAX_LINES}`);

    const linkedFromSkill = new Set<string>();
    for (const file of files.filter((f) => f.endsWith(".md"))) {
      const text = file === "SKILL.md" ? skillText : await readFile(join(folder, file), "utf8");
      checkPointers(skill, file, text);
      for (const target of relativeLinks(text)) {
        const path = resolve(dirname(join(folder, file)), target);
        const inside = relative(folder, path);
        if (inside.split(sep)[0] === ".." || isAbsolute(inside)) {
          fail(skill, file, "reference", `${target} leaves the skill folder`);
          continue;
        }
        if (!(await stat(path).catch(() => undefined)))
          fail(skill, file, "reference", `${target} does not exist`);
        if (file === "SKILL.md") linkedFromSkill.add(inside.split(sep).join("/"));
      }
    }
    for (const file of files.filter((f) => f.split(sep)[0] === "references")) {
      const posix = file.split(sep).join("/");
      if (!linkedFromSkill.has(posix))
        fail(skill, file, "reference", `${posix} is not linked from SKILL.md`);
    }

    if (fields["disable-model-invocation"] === true) {
      const file = join("agents", "openai.yaml");
      const yaml = await readFile(join(folder, file), "utf8").catch(() => undefined);
      let parsed: unknown;
      try {
        parsed = yaml === undefined ? undefined : Bun.YAML.parse(yaml);
      } catch {
        parsed = undefined;
      }
      const config = OpenAiYaml.safeParse(parsed);
      if (!config.success || config.data.policy?.allow_implicit_invocation !== false)
        fail(
          skill,
          file,
          "openai-yaml",
          "disable-model-invocation: true needs policy.allow_implicit_invocation: false",
        );
    }
  }

  const blockText = await readFile(block, "utf8");
  checkPointers(BLOCK_LABEL, "agents-block.md", blockText);
  const size = Buffer.byteLength(blockText);
  if (size > BLOCK_MAX_BYTES)
    fail(BLOCK_LABEL, "agents-block.md", "block-size", `${size} bytes, at most ${BLOCK_MAX_BYTES}`);
  return failures;
}

let pages: ReadonlySet<string>;
let temp: string;
beforeAll(async () => {
  pages = new Set(Object.keys(await build()));
  temp = await mkdtemp(join(tmpdir(), "luciole-skills-content-"));
});
afterAll(() => rm(temp, { recursive: true, force: true }));

test("the shipped skills and block follow every rule", async () => {
  expect(await lint(SKILLS, BLOCK, pages)).toEqual([]);
});

const GOOD_SKILL = `---
name: luciole-good
description: A skill that follows every rule.
---

# Good

Read [the guide](references/guide.md) and \`node_modules/@luciole-sh/core/docs/README.md\`.
`;

/** A fixture: a skills directory holding `luciole-good` with `files` over it, and a block. */
async function fixture(files: Record<string, string>, block = "## luciole\n") {
  const root = await mkdtemp(join(temp, "case-"));
  const skills = join(root, "skills");
  const all: Record<string, string> = {
    "luciole-good/SKILL.md": GOOD_SKILL,
    "luciole-good/references/guide.md": "# Guide\n",
    ...files,
  };
  for (const [path, text] of Object.entries(all)) {
    await mkdir(dirname(join(skills, path)), { recursive: true });
    await writeFile(join(skills, path), text);
  }
  await writeFile(join(root, "agents-block.md"), block);
  return lint(skills, join(root, "agents-block.md"), pages);
}

const skillWith = (frontmatter: string, body = "# Body\n") => `---\n${frontmatter}\n---\n${body}`;

test("a fixture that follows every rule passes", async () => {
  expect(await fixture({})).toEqual([]);
});

const cases: { rule: string; skill: string; file: string; files: Record<string, string> }[] = [
  {
    rule: "frontmatter-fields",
    skill: "luciole-x",
    file: "SKILL.md",
    files: { "luciole-x/SKILL.md": skillWith("name: luciole-x\ndescription: d\nmodel: o3") },
  },
  {
    rule: "name",
    skill: "luciole-x",
    file: "SKILL.md",
    files: { "luciole-x/SKILL.md": skillWith("name: luciole-y\ndescription: d") },
  },
  {
    rule: "name",
    skill: "other",
    file: "SKILL.md",
    files: { "other/SKILL.md": skillWith("name: other\ndescription: d") },
  },
  {
    rule: "name",
    skill: `luciole-${"a".repeat(60)}`,
    file: "SKILL.md",
    files: {
      [`luciole-${"a".repeat(60)}/SKILL.md`]: skillWith(
        `name: luciole-${"a".repeat(60)}\ndescription: d`,
      ),
    },
  },
  {
    rule: "description",
    skill: "luciole-x",
    file: "SKILL.md",
    files: { "luciole-x/SKILL.md": skillWith("name: luciole-x\ndescription: ''") },
  },
  {
    rule: "description",
    skill: "luciole-x",
    file: "SKILL.md",
    files: {
      "luciole-x/SKILL.md": skillWith(`name: luciole-x\ndescription: ${"d".repeat(1025)}`),
    },
  },
  {
    rule: "body-length",
    skill: "luciole-x",
    file: "SKILL.md",
    files: {
      "luciole-x/SKILL.md": skillWith("name: luciole-x\ndescription: d", "line\n".repeat(501)),
    },
  },
  {
    rule: "reference",
    skill: "luciole-x",
    file: "SKILL.md",
    files: {
      "luciole-x/SKILL.md": skillWith("name: luciole-x\ndescription: d", "[out](../a/SKILL.md)\n"),
    },
  },
  {
    rule: "reference",
    skill: "luciole-x",
    file: join("references", "a.md"),
    files: {
      "luciole-x/SKILL.md": skillWith("name: luciole-x\ndescription: d", "[a](references/a.md)\n"),
      "luciole-x/references/a.md": "[missing](b.md)\n",
    },
  },
  {
    rule: "reference",
    skill: "luciole-x",
    file: join("references", "orphan.md"),
    files: {
      "luciole-x/SKILL.md": skillWith("name: luciole-x\ndescription: d"),
      "luciole-x/references/orphan.md": "# Orphan\n",
    },
  },
  {
    rule: "reference",
    skill: "luciole-x",
    file: join("references", "deep.md"),
    files: {
      "luciole-x/SKILL.md": skillWith("name: luciole-x\ndescription: d", "[a](references/a.md)\n"),
      "luciole-x/references/a.md": "[deep](deep.md)\n",
      "luciole-x/references/deep.md": "# Linked from a reference only\n",
    },
  },
  {
    rule: "reference",
    skill: "luciole-x",
    file: "SKILL.md",
    files: {
      "luciole-x/SKILL.md": skillWith(
        "name: luciole-x\ndescription: d",
        "See [the other skill][other].\n\n[other]: ../luciole-good/SKILL.md\n",
      ),
    },
  },
  {
    rule: "docs-pointer",
    skill: "luciole-x",
    file: join("references", "a.md"),
    files: {
      "luciole-x/SKILL.md": skillWith("name: luciole-x\ndescription: d", "[a](references/a.md)\n"),
      "luciole-x/references/a.md": "See `node_modules/@luciole-sh/core/docs/no-such-page.md`.\n",
    },
  },
  {
    rule: "openai-yaml",
    skill: "luciole-x",
    file: join("agents", "openai.yaml"),
    files: {
      "luciole-x/SKILL.md": skillWith(
        "name: luciole-x\ndescription: d\ndisable-model-invocation: true",
      ),
    },
  },
  {
    rule: "openai-yaml",
    skill: "luciole-x",
    file: join("agents", "openai.yaml"),
    files: {
      "luciole-x/SKILL.md": skillWith(
        "name: luciole-x\ndescription: d\ndisable-model-invocation: true",
      ),
      "luciole-x/agents/openai.yaml": "policy:\n  allow_implicit_invocation: true\n",
    },
  },
];

test.each(cases)("$rule fails naming $skill and $file", async ({ rule, skill, file, files }) => {
  const failures = await fixture(files);
  expect(failures).toHaveLength(1);
  expect(failures[0]).toStartWith(`${skill}: ${file}: ${rule}: `);
});

test("a user-invoked skill passes with its openai.yaml", async () => {
  const failures = await fixture({
    "luciole-x/SKILL.md": skillWith(
      "name: luciole-x\ndescription: d\ndisable-model-invocation: true",
    ),
    "luciole-x/agents/openai.yaml": "policy:\n  allow_implicit_invocation: false\n",
  });
  expect(failures).toEqual([]);
});

test("the block fails over 8 KB and on a docs pointer to no page", async () => {
  expect(await fixture({}, "x".repeat(8 * 1024 + 1))).toEqual([
    `${BLOCK_LABEL}: agents-block.md: block-size: 8193 bytes, at most 8192`,
  ]);
  const [failure] = await fixture({}, "Read `node_modules/@luciole-sh/core/docs/nope.md`.\n");
  expect(failure).toStartWith(`${BLOCK_LABEL}: agents-block.md: docs-pointer: `);
});
