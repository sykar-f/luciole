import { afterAll, beforeEach, expect, test } from "bun:test";
import { mkdir, readdir, rm, symlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import { z } from "zod";
import {
  installSkills,
  MANIFEST_FILE,
  parseAgents,
  removeSkills,
  stamp,
  staleNotice,
  STALE_EXIT_CODE,
  statusSkills,
  type SkillsOptions,
} from "../packages/core/src/commands/skills";
import { messageOf } from "../packages/core/src/guards";
import { execute, isolatedTemporary, rejectionOf } from "./helpers";

const temp = await isolatedTemporary("luciole-skills-test-");
afterAll(() => rm(temp, { recursive: true, force: true }));

const Recorded = z.object({ version: z.string(), files: z.record(z.string(), z.string()) });
const SKILL = "---\nname: luciole-demo\ndescription: A demo skill.\n---\n\n# Demo\n";
const BLOCK = "## luciole\n\nRead the docs.\n";

let root: string;
let counter = 0;
/** A fresh app, home and package: `source` holds one skill with a reference file. */
async function fixture() {
  root = join(temp, `case-${counter++}`);
  const source = join(root, "package/skills");
  await Bun.write(join(source, "luciole-demo/SKILL.md"), SKILL);
  await Bun.write(join(source, "luciole-demo/references/a.md"), "reference\n");
  await Bun.write(join(root, "package/block.md"), BLOCK);
  await mkdir(join(root, "app"), { recursive: true });
  await mkdir(join(root, "home"), { recursive: true });
}
beforeEach(fixture);

type Output = { logs: string[]; warnings: string[] };
function optionsFor(over: Partial<SkillsOptions> = {}): SkillsOptions & Output {
  const out: Output = { logs: [], warnings: [] };
  return {
    directory: join(root, "app"),
    home: join(root, "home"),
    source: join(root, "package/skills"),
    blockSource: join(root, "package/block.md"),
    version: "1.0.0",
    global: false,
    agents: ["agents", "claude"],
    dryRun: false,
    force: false,
    log: (line) => out.logs.push(line),
    warn: (line) => out.warnings.push(line),
    ...out,
    ...over,
  };
}
const app = (path: string) => join(root, "app", path);
const text = (path: string) => Bun.file(app(path)).text();
const exists = (path: string) => Bun.file(app(path)).exists();
/** Every file under `directory`, to compare a tree before and after. */
async function snapshot(directory = join(root, "app")) {
  const entries = await readdir(directory, { recursive: true, withFileTypes: true });
  const found: Record<string, string> = {};
  for (const entry of entries)
    found[join(entry.parentPath, entry.name)] = entry.isFile()
      ? await Bun.file(join(entry.parentPath, entry.name)).text()
      : "<dir>";
  return found;
}

test("install writes both targets, the stamps and the block", async () => {
  const options = optionsFor();
  await installSkills(options);
  for (const target of [".agents/skills", ".claude/skills"]) {
    const skill = await text(`${target}/luciole-demo/SKILL.md`);
    expect(skill).toContain('metadata:\n  luciole-version: "1.0.0"');
    // Nothing else in the file changes.
    expect(skill.replace('metadata:\n  luciole-version: "1.0.0"\n', "")).toBe(SKILL);
    expect(await text(`${target}/luciole-demo/references/a.md`)).toBe("reference\n");
    const manifest = Recorded.parse(JSON.parse(await text(`${target}/${MANIFEST_FILE}`)));
    expect(manifest.version).toBe("1.0.0");
    expect(Object.keys(manifest.files).sort()).toEqual([
      "luciole-demo/SKILL.md",
      "luciole-demo/references/a.md",
    ]);
  }
  const agents = await text("AGENTS.md");
  expect(agents).toStartWith("<!-- BEGIN:luciole -->\n");
  expect(agents).toContain("Read the docs.");
  expect(agents).toEndWith("<!-- END:luciole -->\n");
  expect(await text("CLAUDE.md")).toContain("@AGENTS.md");
});

test("a second install changes nothing and says up to date", async () => {
  await installSkills(optionsFor());
  const before = await snapshot();
  const again = optionsFor();
  await installSkills(again);
  expect(again.logs).toEqual(["up to date"]);
  expect(again.warnings).toEqual([]);
  expect(await snapshot()).toEqual(before);
});

test("a new version updates the stamps, and the block, of files the user did not edit", async () => {
  await installSkills(optionsFor());
  const next = optionsFor({ version: "1.1.0" });
  await installSkills(next);
  expect(next.logs.join("\n")).toContain("updated .agents/skills/luciole-demo/SKILL.md");
  expect(await text(".claude/skills/luciole-demo/SKILL.md")).toContain('"1.1.0"');
  expect(await text("AGENTS.md")).toContain("luciole-version: 1.1.0");
  expect(Recorded.parse(JSON.parse(await text(`.agents/skills/${MANIFEST_FILE}`))).version).toBe(
    "1.1.0",
  );
});

test("a modified file survives install without --force and is replaced with it", async () => {
  await installSkills(optionsFor());
  const edited = `${await text(".agents/skills/luciole-demo/SKILL.md")}\nMine.\n`;
  await Bun.write(app(".agents/skills/luciole-demo/SKILL.md"), edited);
  await Bun.write(app("AGENTS.md"), (await text("AGENTS.md")).replace("Read the docs.", "Mine."));

  const kept = optionsFor({ version: "1.1.0" });
  await installSkills(kept);
  expect(await text(".agents/skills/luciole-demo/SKILL.md")).toBe(edited);
  expect(await text("AGENTS.md")).toContain("Mine.");
  expect(kept.warnings.join("\n")).toContain("modified locally");
  expect(kept.warnings.join("\n")).toContain("luciole block");
  // The untouched copy still moved to the new version.
  expect(await text(".claude/skills/luciole-demo/SKILL.md")).toContain('"1.1.0"');

  await installSkills(optionsFor({ version: "1.1.0", force: true }));
  expect(await text(".agents/skills/luciole-demo/SKILL.md")).not.toContain("Mine.");
  expect(await text(".agents/skills/luciole-demo/SKILL.md")).toContain('"1.1.0"');
  expect(await text("AGENTS.md")).toContain("Read the docs.");
});

test("a foreign folder of the same name is refused, and nothing is written", async () => {
  await Bun.write(app(".claude/skills/luciole-demo/SKILL.md"), "someone else's\n");
  const before = await snapshot();
  const refused = await rejectionOf(installSkills(optionsFor()));
  expect(messageOf(refused)).toContain(".claude/skills/luciole-demo exists and is not luciole's");
  expect(await snapshot()).toEqual(before);
  // --force does not take over a folder luciole does not own either.
  expect(messageOf(await rejectionOf(installSkills(optionsFor({ force: true }))))).toContain(
    "not luciole's",
  );
});

test("status reports stale after the stamp is bumped, and exits non-zero", async () => {
  await installSkills(optionsFor());
  const current = optionsFor();
  expect(await statusSkills(current)).toBe(0);
  expect(current.logs.join("\n")).toContain("up to date");

  const bumped = optionsFor({ version: "2.0.0" });
  expect(await statusSkills(bumped)).toBe(STALE_EXIT_CODE);
  const report = bumped.logs.join("\n");
  expect(report).toMatch(/\.agents\/skills\s+luciole-demo\s+stale/);
  expect(report).toMatch(/AGENTS\.md\s+luciole block\s+stale/);
  expect(bumped.warnings.join("\n")).toContain("STALE_EXIT_CODE");
});

test("status reports missing and modified, and only stale or missing fail", async () => {
  const empty = optionsFor();
  expect(await statusSkills(empty)).toBe(STALE_EXIT_CODE);
  expect(empty.logs.join("\n")).toMatch(/luciole-demo\s+missing/);
  expect(empty.logs.join("\n")).toMatch(/luciole block\s+missing/);

  await installSkills(optionsFor());
  await Bun.write(app(".agents/skills/luciole-demo/SKILL.md"), "mine\n");
  const edited = optionsFor();
  expect(await statusSkills(edited)).toBe(0);
  expect(edited.logs.join("\n")).toMatch(/\.agents\/skills\s+luciole-demo\s+modified locally/);
});

test("remove leaves the directory as it was, user content included", async () => {
  await Bun.write(app("AGENTS.md"), "# My rules\n\nBe kind.\n");
  await Bun.write(app("CLAUDE.md"), "# Claude notes\n");
  await Bun.write(app(".claude/settings.json"), "{}\n");
  const before = await snapshot();
  await installSkills(optionsFor());
  expect(await text("AGENTS.md")).toStartWith("# My rules\n\nBe kind.\n\n<!-- BEGIN:luciole -->");
  expect(await text("CLAUDE.md")).toContain("@AGENTS.md");
  await removeSkills(optionsFor());
  expect(await snapshot()).toEqual(before);
});

test("remove deletes the files install created, and the directories left empty", async () => {
  const before = await snapshot();
  await installSkills(optionsFor());
  await removeSkills(optionsFor());
  expect(await snapshot()).toEqual(before);
  expect(await exists("AGENTS.md")).toBe(false);
  expect(await exists(".agents")).toBe(false);
});

test("remove leaves a modified file, and its manifest, unless --force", async () => {
  await installSkills(optionsFor());
  await Bun.write(app(".agents/skills/luciole-demo/SKILL.md"), "mine\n");
  const kept = optionsFor();
  await removeSkills(kept);
  expect(kept.warnings.join("\n")).toContain("modified locally");
  expect(await text(".agents/skills/luciole-demo/SKILL.md")).toBe("mine\n");
  expect(await exists(".claude/skills")).toBe(false);
  const manifest = Recorded.parse(JSON.parse(await text(`.agents/skills/${MANIFEST_FILE}`)));
  expect(Object.keys(manifest.files)).toEqual(["luciole-demo/SKILL.md"]);

  await removeSkills(optionsFor({ force: true }));
  expect(await exists(".agents")).toBe(false);
});

test("--dry-run writes nothing", async () => {
  const before = await snapshot();
  const dry = optionsFor({ dryRun: true });
  await installSkills(dry);
  expect(await snapshot()).toEqual(before);
  expect(dry.logs.join("\n")).toContain("would have wrote .agents/skills/luciole-demo/SKILL.md");

  await installSkills(optionsFor());
  const installed = await snapshot();
  await removeSkills(optionsFor({ dryRun: true }));
  expect(await snapshot()).toEqual(installed);
});

test("--agent claude writes only .claude/skills", async () => {
  await installSkills(optionsFor({ agents: parseAgents("claude") }));
  expect(await exists(".claude/skills/luciole-demo/SKILL.md")).toBe(true);
  expect(await exists(".agents")).toBe(false);
  expect(await exists("AGENTS.md")).toBe(true);
  await installSkills(optionsFor({ agents: parseAgents("agents") }));
  expect(await exists(".agents/skills/luciole-demo/SKILL.md")).toBe(true);
  expect(() => parseAgents("cursor")).toThrow("--agent takes agents, claude");
});

test("--global writes the skills to the home and never AGENTS.md", async () => {
  const options = optionsFor({ global: true });
  await installSkills(options);
  expect(options.logs.join("\n")).toContain("follow the luciole version that installed them");
  expect(await Bun.file(join(root, "home/.agents/skills/luciole-demo/SKILL.md")).exists()).toBe(
    true,
  );
  expect(await Bun.file(join(root, "home/.claude/skills/luciole-demo/SKILL.md")).exists()).toBe(
    true,
  );
  expect(await exists("AGENTS.md")).toBe(false);
  expect(await statusSkills(optionsFor({ global: true }))).toBe(0);
  await removeSkills(optionsFor({ global: true }));
  expect(await readdir(join(root, "home"))).toEqual([]);
});

test("a CLAUDE.md that is AGENTS.md, or imports it, is left alone", async () => {
  await Bun.write(app("AGENTS.md"), "# Rules\n");
  await symlink("AGENTS.md", app("CLAUDE.md"));
  await installSkills(optionsFor());
  expect((await text("CLAUDE.md")).match(/@AGENTS\.md/g)).toBeNull();
  await rm(app("CLAUDE.md"));
  await Bun.write(app("CLAUDE.md"), "See:\n@AGENTS.md\n");
  await installSkills(optionsFor());
  expect(await text("CLAUDE.md")).toBe("See:\n@AGENTS.md\n");
});

test("a version no longer shipping a file removes it, unless the user edited it", async () => {
  await installSkills(optionsFor());
  await rm(join(root, "package/skills/luciole-demo/references"), { recursive: true });
  await installSkills(optionsFor({ version: "1.1.0" }));
  expect(await exists(".agents/skills/luciole-demo/references/a.md")).toBe(false);
  expect(await exists(".agents/skills/luciole-demo/SKILL.md")).toBe(true);
});

test("stamp sets the version in the frontmatter and nothing else", () => {
  expect(stamp(SKILL, "1.2.3")).toBe(
    '---\nname: luciole-demo\ndescription: A demo skill.\nmetadata:\n  luciole-version: "1.2.3"\n---\n\n# Demo\n',
  );
  const withMetadata = "---\nname: x\nmetadata:\n    author: me\n---\nbody\n";
  expect(stamp(withMetadata, "1.2.3")).toBe(
    '---\nname: x\nmetadata:\n    author: me\n    luciole-version: "1.2.3"\n---\nbody\n',
  );
  // Stamping again replaces the stamp.
  expect(stamp(stamp(withMetadata, "1.0.0"), "1.2.3")).toBe(stamp(withMetadata, "1.2.3"));
  expect(() => stamp("no frontmatter\n", "1")).toThrow("no frontmatter");
});

test("the stale notice names both versions, and is silent in CI or without a manifest", async () => {
  const directory = join(root, "app");
  expect(await staleNotice(directory, "1.0.0", {})).toBeUndefined();
  await installSkills(optionsFor());
  expect(await staleNotice(directory, "1.0.0", {})).toBeUndefined();
  const notice = await staleNotice(directory, "2.0.0", {});
  expect(notice).toContain("1.0.0");
  expect(notice).toContain("2.0.0");
  expect(notice).toContain("luciole skills");
  expect(notice?.includes("\n")).toBe(false);
  expect(await staleNotice(directory, "2.0.0", { CI: "true" })).toBeUndefined();
  expect(await staleNotice(directory, "2.0.0", { CI: "" })).toContain("luciole 1.0.0");
  await Bun.write(app(`.agents/skills/${MANIFEST_FILE}`), "not json");
  expect(await staleNotice(directory, "2.0.0", {})).toBeUndefined();
});

const cli = resolve(import.meta.dir, "../packages/core/src/cli.ts");
const luciole = (args: string[], env: Record<string, string | undefined> = {}) =>
  execute([process.execPath, cli, ...args], { env: { ...process.env, CI: "", ...env } });

test("luciole skills runs end to end, and status exits with its named code", async () => {
  const directory = app("");
  const install = await luciole(["skills", "--app", directory]);
  expect(install.exitCode, install.stderr.toString()).toBe(0);
  expect(await exists(".agents/skills/luciole-app/SKILL.md")).toBe(true);
  expect(await text("AGENTS.md")).toContain("node_modules/@luciole-sh/core/docs/README.md");
  const status = await luciole(["skills", "status", "--app", directory]);
  expect(status.exitCode).toBe(0);
  // A skill removed by hand is missing.
  await rm(app(".claude/skills/luciole-app"), { recursive: true });
  const stale = await luciole(["skills", "status", "--app", directory]);
  expect(stale.exitCode).toBe(STALE_EXIT_CODE);
  const typo = await luciole(["skills", "--agnt", "claude"]);
  expect(typo.exitCode).toBe(2);
  const unknown = await luciole(["skills", "frobnicate"]);
  expect(unknown.exitCode).toBe(2);
  const remove = await luciole(["skills", "remove", "--app", directory]);
  expect(remove.exitCode, remove.stderr.toString()).toBe(0);
  expect(await readdir(directory)).toEqual([]);
});
