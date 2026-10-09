import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { lstat, mkdir, readdir, readFile, realpath, rm, rmdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { z } from "zod";
import { ArgsError } from "../args";
import { messageOf } from "../guards";
import { readPackageJson } from "../package-json";
import { frameworkRoot, type Command } from "./command";

/**
 * The agent material that ships with the framework: Agent Skills (`SKILL.md` folders) and a
 * managed block in the app's `AGENTS.md`. It is copied into the app, at the version of the
 * running core, so a fresh clone works before `bun install` and agents read what matches.
 */

/** What `luciole skills status` exits with when a skill or the block is stale or missing. */
export const STALE_EXIT_CODE = 3;
/** The manifest each target directory holds: what luciole wrote there, and its hashes. */
export const MANIFEST_FILE = ".luciole-skills.json";
// Column widths of the status table.
const WHERE_WIDTH = 24;
const WHAT_WIDTH = 20;
const SKILL_PREFIX = "luciole-";
const BLOCK_BEGIN = "<!-- BEGIN:luciole -->";
const BLOCK_END = "<!-- END:luciole -->";
const IMPORT_BEGIN = "<!-- BEGIN:luciole-import -->";
const IMPORT_END = "<!-- END:luciole-import -->";
const IMPORT_LINE = "@AGENTS.md";
const VERSION_KEY = "luciole-version";

/** The agents' skill directories: `agents` is read by most tools, `claude` by Claude Code. */
const AGENT_DIRECTORIES = { agents: ".agents/skills", claude: ".claude/skills" } as const;
export type Agent = keyof typeof AGENT_DIRECTORIES;
const AGENTS: readonly Agent[] = ["agents", "claude"];
const isAgent = (name: string): name is Agent => AGENTS.some((agent) => agent === name);

const Manifest = z.object({
  version: z.string(),
  files: z.record(z.string(), z.string()),
  block: z.string().optional(),
});
type Manifest = z.infer<typeof Manifest>;

export type SkillsOptions = {
  /** The application directory. */
  directory: string;
  /** Where `--global` writes: the user's home. */
  home: string;
  /** The package's skills: one folder per skill. */
  source: string;
  /** The package's block: markdown, without markers. */
  blockSource: string;
  /** The core's version, stamped into what is written. */
  version: string;
  global: boolean;
  agents: readonly Agent[];
  dryRun: boolean;
  force: boolean;
  log: (line: string) => void;
  warn: (line: string) => void;
};

/** What ships in this package, at this package's version. */
export async function packagedMaterial() {
  const { version } = await readPackageJson(join(frameworkRoot, "package.json"));
  if (!version) throw new Error(`${frameworkRoot}: no version`);
  return {
    source: join(frameworkRoot, "skills"),
    blockSource: join(frameworkRoot, "agents-block.md"),
    version,
  };
}

const hash = (data: string | Uint8Array) => createHash("sha256").update(data).digest("hex");
const read = (file: string) => readFile(file).catch(() => undefined);
const readText = async (file: string) => (await read(file))?.toString("utf8");
const same = (a: Uint8Array, b: Uint8Array) => Buffer.compare(a, b) === 0;

/**
 * `text`, a SKILL.md, with `metadata.luciole-version` set in its frontmatter (the spec's
 * `metadata` map, string values). Nothing else changes.
 */
export function stamp(text: string, version: string, name = "SKILL.md"): string {
  const lines = text.split("\n");
  const close = lines.findIndex((line, i) => i > 0 && line.trimEnd() === "---");
  if (lines[0]?.trimEnd() !== "---" || close < 0) throw new Error(`${name}: no frontmatter`);
  const entry = (indent: string) => `${indent}${VERSION_KEY}: "${version}"`;
  const metadata = lines.findIndex((line, i) => i < close && /^metadata:\s*$/.test(line));
  if (lines.some((line, i) => i < close && /^metadata:\s*\S/.test(line)))
    throw new Error(`${name}: metadata must be a block map to carry ${VERSION_KEY}`);
  if (metadata < 0) {
    lines.splice(close, 0, "metadata:", entry("  "));
    return lines.join("\n");
  }
  let end = metadata + 1;
  while (end < close && /^\s+\S/.test(lines[end] ?? "")) end++;
  const indent = /^(\s+)/.exec(lines[metadata + 1] ?? "")?.[1] ?? "  ";
  const existing = lines.findIndex(
    (line, i) => i > metadata && i < end && line.trim().startsWith(`${VERSION_KEY}:`),
  );
  if (existing >= 0) lines[existing] = entry(indent);
  else lines.splice(end, 0, entry(indent));
  return lines.join("\n");
}

/**
 * The one gate to a path under a target directory, which every read, write and delete there
 * goes through: the command never follows a symbolic link inside a target. Each component from
 * the target's real directory down to `path`, the file included, is checked with `lstat`; a
 * link refuses the whole operation. (The target itself may be a link: it resolves to the
 * directory the user chose.) Resolves with the path to use.
 */
async function inside(directory: string, path: string): Promise<string> {
  const real = await realpath(directory).catch(() => directory);
  let current = real;
  for (const part of path.split("/")) {
    current = join(current, part);
    const info = await lstat(current).catch(() => undefined);
    if (!info) break;
    if (info.isSymbolicLink())
      throw new Error(`${current}: a symbolic link, which luciole never follows: refused`);
  }
  return join(real, path);
}
const readIn = async (directory: string, path: string) => read(await inside(directory, path));
const existsIn = async (directory: string, path: string) =>
  existsSync(await inside(directory, path));

/**
 * Every file under `directory`, as paths relative to it, in a stable order. With `strict`,
 * a symbolic link anywhere in it is refused rather than skipped.
 */
async function filesUnder(directory: string, prefix = "", strict = false): Promise<string[]> {
  const entries = await readdir(join(directory, prefix), { withFileTypes: true }).catch(() => []);
  const found: string[] = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (strict && entry.isSymbolicLink())
      throw new Error(
        `${join(directory, path)}: a symbolic link, which luciole never follows: refused`,
      );
    if (entry.isDirectory()) found.push(...(await filesUnder(directory, path, strict)));
    else if (entry.isFile()) found.push(path);
  }
  return found;
}

/** What the package ships, as `<skill>/<file>` paths to the bytes to write (SKILL.md stamped). */
async function desiredFiles(options: SkillsOptions) {
  const desired = new Map<string, Uint8Array>();
  const entries = await readdir(options.source, { withFileTypes: true });
  for (const entry of entries.filter((each) => each.isDirectory())) {
    if (!entry.name.startsWith(SKILL_PREFIX))
      throw new Error(`${options.source}/${entry.name}: a skill is named ${SKILL_PREFIX}*`);
    for (const file of await filesUnder(join(options.source, entry.name))) {
      const path = `${entry.name}/${file}`;
      const bytes = await readFile(join(options.source, path));
      desired.set(
        path,
        file === "SKILL.md"
          ? Buffer.from(stamp(bytes.toString("utf8"), options.version, path))
          : bytes,
      );
    }
  }
  return desired;
}

type Target = { label: string; directory: string };
function targetsOf(options: SkillsOptions, agents: readonly Agent[]): Target[] {
  const base = options.global ? options.home : options.directory;
  return agents.map((agent) => ({
    label: `${options.global ? "~/" : ""}${AGENT_DIRECTORIES[agent]}`,
    directory: join(base, AGENT_DIRECTORIES[agent]),
  }));
}

async function readManifest(target: Target): Promise<Manifest | undefined> {
  const text = (await readIn(target.directory, MANIFEST_FILE))?.toString("utf8");
  if (text === undefined) return undefined;
  try {
    const parsed = Manifest.safeParse(JSON.parse(text));
    if (parsed.success && (await staysInside(target.directory, Object.keys(parsed.data.files))))
      return parsed.data;
  } catch {
    // Reported below, with the file.
  }
  throw new Error(`${join(target.directory, MANIFEST_FILE)}: not a luciole skills manifest`);
}

/**
 * Whether every manifest path is a plain relative path that lies in `directory`: the manifest
 * names what `remove` and `install` delete, so a forged one must not reach beyond its folder.
 */
async function staysInside(directory: string, paths: readonly string[]) {
  const real = await realpath(directory);
  return paths.every(
    (path) =>
      path !== "" &&
      !isAbsolute(path) &&
      path.split("/").every((part) => part !== "" && part !== "." && part !== "..") &&
      resolve(real, path).startsWith(real + sep),
  );
}

/**
 * Whether the folder of `skill` holds only files this core would write, byte for byte: what an
 * install interrupted before its manifest leaves. Such a folder is luciole's, not a stranger's.
 */
async function isUnrecordedCopy(
  directory: string,
  skill: string,
  desired: ReadonlyMap<string, Uint8Array>,
) {
  await inside(directory, skill);
  for (const file of await filesUnder(join(await realpath(directory), skill), "", true)) {
    const wanted = desired.get(`${skill}/${file}`);
    const disk = await readIn(directory, `${skill}/${file}`);
    if (!wanted || !disk || !same(disk, wanted)) return false;
  }
  return true;
}
const manifestText = (manifest: Manifest) =>
  `${JSON.stringify({ ...manifest, files: Object.fromEntries(Object.entries(manifest.files).sort(([a], [b]) => a.localeCompare(b))) }, null, 2)}\n`;

type State = "current" | "stale" | "modified" | "missing" | "foreign";
const LABEL: Record<State, string> = {
  current: "up to date",
  stale: "stale",
  modified: "modified locally",
  missing: "missing",
  foreign: "not luciole's",
};
const WORST: State[] = ["missing", "stale", "modified", "foreign", "current"];

/** The state of one file: what is on disk, what would be written, what luciole wrote. */
function fileState(
  disk: Uint8Array | undefined,
  wanted: Uint8Array,
  owned: string | undefined,
): State {
  if (!disk) return "missing";
  if (same(disk, wanted)) return "current";
  return owned !== undefined && hash(disk) === owned ? "stale" : "modified";
}

/** The managed block's text, markers included. */
async function blockText(options: SkillsOptions) {
  const body = (await readFile(options.blockSource, "utf8")).trim();
  return `${BLOCK_BEGIN}\n<!-- ${VERSION_KEY}: ${options.version} -->\n${body}\n${BLOCK_END}`;
}
const importText = `${IMPORT_BEGIN}\n${IMPORT_LINE}\n${IMPORT_END}`;

/** Where a marked block lies in `text`, or `undefined`. A begin without its end is refused. */
function locate(text: string, begin: string, end: string, file: string) {
  const start = text.indexOf(begin);
  if (start < 0) return undefined;
  const stop = text.indexOf(end, start);
  if (stop < 0) throw new Error(`${file}: ${begin} has no ${end}`);
  return { start, stop: stop + end.length };
}
/** `text` with `block` added at its end, a blank line apart. */
const appended = (text: string, block: string) =>
  text.length === 0 ? `${block}\n` : `${text}${text.endsWith("\n") ? "\n" : "\n\n"}${block}\n`;
/** `text` without the block at `at` and the blank line `appended` put before it. */
function without(text: string, at: { start: number; stop: number }) {
  let before = text.slice(0, at.start);
  let after = text.slice(at.stop);
  if (after.startsWith("\n")) after = after.slice(1);
  if (before.endsWith("\n\n")) before = before.slice(0, -1);
  return before + after;
}

/** The block in `AGENTS.md` against the one this core would write. */
async function blockState(options: SkillsOptions, recorded: string | undefined) {
  const file = join(options.directory, "AGENTS.md");
  const text = await readText(file);
  const wanted = await blockText(options);
  const at = text === undefined ? undefined : locate(text, BLOCK_BEGIN, BLOCK_END, file);
  const current = text === undefined || !at ? undefined : text.slice(at.start, at.stop);
  let state: State;
  if (current === undefined) state = "missing";
  else if (current === wanted) state = "current";
  else if (recorded !== undefined) state = hash(current) === recorded ? "stale" : "modified";
  else {
    // Nothing says who wrote it: another version is stale, the same version edited is the user's.
    const written = new RegExp(`${VERSION_KEY}: (\\S+) -->`).exec(current)?.[1];
    state = written !== undefined && written !== options.version ? "stale" : "modified";
  }
  return { state, text, current, wanted, at, file };
}

/** CLAUDE.md imports AGENTS.md: by a line of its own, or because it is the same file. */
async function importState(
  options: SkillsOptions,
): Promise<{ state: State; text: string | undefined; claude: string }> {
  const claude = join(options.directory, "CLAUDE.md");
  const text = await readText(claude);
  if (text === undefined) return { state: "missing", text, claude };
  const agents = join(options.directory, "AGENTS.md");
  const linked =
    existsSync(agents) && (await realpath(agents).catch(() => "")) === (await realpath(claude));
  const imported = linked || /^@AGENTS\.md[ \t]*$/m.test(text);
  return { state: imported ? "current" : "missing", text, claude };
}

const shown = (options: SkillsOptions, file: string) =>
  options.global ? file.replace(options.home, "~") : relative(options.directory, file) || ".";

async function write(options: SkillsOptions, file: string, data: string | Uint8Array) {
  if (options.dryRun) return;
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, data);
}

/** `luciole skills install`: writes the skills and the block, leaving the user's files alone. */
export async function installSkills(options: SkillsOptions): Promise<void> {
  const desired = await desiredFiles(options);
  const targets = targetsOf(options, options.agents);
  const refusals: string[] = [];
  const done: string[] = [];
  const plans: {
    target: Target;
    writes: [string, Uint8Array][];
    removes: string[];
    manifest: Manifest;
    skipped: boolean;
    old: Manifest | undefined;
  }[] = [];

  // The block's recorded hash is in the manifests of the project, whichever the run narrows to.
  const projectManifests = options.global
    ? []
    : (await Promise.all(targetsOf(options, AGENTS).map(readManifest))).flatMap((m) => m ?? []);
  const recorded = projectManifests.find((each) => each.block !== undefined)?.block;
  let blockHash: string | undefined = recorded;
  let blockWrite: [string, string] | undefined;
  let importWrite: [string, string] | undefined;
  if (!options.global) {
    const block = await blockState(options, recorded);
    const label = shown(options, block.file);
    if (block.state === "current") blockHash = hash(block.wanted);
    else if (block.state === "modified" && !options.force)
      options.warn(
        `${label}: the luciole block was modified locally, left alone (--force replaces it)`,
      );
    else {
      const next =
        block.text === undefined
          ? `${block.wanted}\n`
          : block.at
            ? block.text.slice(0, block.at.start) + block.wanted + block.text.slice(block.at.stop)
            : appended(block.text, block.wanted);
      blockWrite = [block.file, next];
      blockHash = hash(block.wanted);
      done.push(`${block.state === "missing" ? "added" : "updated"} the luciole block in ${label}`);
    }
    const imports = await importState(options);
    if (imports.state === "missing") {
      importWrite = [
        imports.claude,
        imports.text === undefined ? `${importText}\n` : appended(imports.text, importText),
      ];
      done.push(`${imports.text === undefined ? "created" : "added the import to"} CLAUDE.md`);
    }
  }

  for (const target of targets) {
    const old = await readManifest(target);
    const files: Record<string, string> = {};
    const writes: [string, Uint8Array][] = [];
    const removes: string[] = [];
    let skipped = false;
    const owns = (skill: string) =>
      Object.keys(old?.files ?? {}).some((p) => p.startsWith(`${skill}/`));
    const foreign = new Set<string>();
    // A folder with no record that holds only our own bytes is a partial install: adopted.
    const adopted = new Set<string>();
    for (const skill of new Set([...desired.keys()].map((path) => path.split("/")[0] ?? path)))
      if (
        !owns(skill) &&
        (await existsIn(target.directory, skill)) &&
        (await isUnrecordedCopy(target.directory, skill, desired))
      )
        adopted.add(skill);
    for (const [path, wanted] of desired) {
      const skill = path.split("/")[0] ?? path;
      if (!adopted.has(skill) && !owns(skill) && (await existsIn(target.directory, skill))) {
        if (!foreign.has(skill))
          refusals.push(
            `${target.label}/${skill} exists and is not luciole's: refused, move it first`,
          );
        foreign.add(skill);
        continue;
      }
      const state = fileState(await readIn(target.directory, path), wanted, old?.files[path]);
      if (state === "current") files[path] = hash(wanted);
      else if (state === "modified" && !options.force) {
        skipped = true;
        options.warn(`${target.label}/${path}: modified locally, left alone (--force replaces it)`);
        const kept = old?.files[path];
        if (kept !== undefined) files[path] = kept;
      } else {
        files[path] = hash(wanted);
        writes.push([path, wanted]);
        done.push(`${state === "missing" ? "wrote" : "updated"} ${target.label}/${path}`);
      }
    }
    // What an older version shipped and this one does not: removed unless the user edited it.
    for (const [path, owned] of Object.entries(old?.files ?? {})) {
      if (desired.has(path)) continue;
      const disk = await readIn(target.directory, path);
      if (!disk) continue;
      if (hash(disk) === owned || options.force) {
        removes.push(path);
        done.push(`removed ${target.label}/${path}`);
      } else {
        skipped = true;
        files[path] = owned;
        options.warn(`${target.label}/${path}: no longer shipped but modified, left alone`);
      }
    }
    const manifest: Manifest = {
      version: skipped && old ? old.version : options.version,
      files,
      ...(blockHash !== undefined ? { block: blockHash } : {}),
    };
    if (old === undefined && Object.keys(files).length === 0) continue;
    if (!old || manifestText(old) !== manifestText(manifest)) {
      if (adopted.size === 0 && writes.length === 0 && removes.length === 0 && old === undefined)
        continue;
      done.push(`recorded ${target.label}/${MANIFEST_FILE}`);
    }
    plans.push({ target, writes, removes, manifest, skipped, old });
  }

  if (refusals.length > 0) throw new Error(refusals.join("\n"));

  const changes = done.filter((line) => !line.startsWith("recorded"));
  if (options.global)
    options.log(
      "Global skills follow the luciole version that installed them, not each project's.",
    );
  if (
    changes.length === 0 &&
    !plans.some((plan) => !plan.old || manifestText(plan.old) !== manifestText(plan.manifest))
  ) {
    options.log("up to date");
    return;
  }
  for (const line of done) options.log(options.dryRun ? `would have ${line}` : line);
  if (options.dryRun) return;
  for (const plan of plans) {
    for (const [path, data] of plan.writes)
      await write(options, await inside(plan.target.directory, path), data);
    for (const path of plan.removes) await removeFile(plan.target.directory, path);
    const text = manifestText(plan.manifest);
    if (!plan.old || manifestText(plan.old) !== text)
      await write(options, await inside(plan.target.directory, MANIFEST_FILE), text);
  }
  if (blockWrite) await write(options, blockWrite[0], blockWrite[1]);
  if (importWrite) await write(options, importWrite[0], importWrite[1]);
  if (changes.length === 0) options.log("up to date");
}

/** Deletes `path` under `directory`, then the folders it leaves empty. */
async function removeFile(directory: string, path: string) {
  await rm(await inside(directory, path), { force: true });
  for (let dir = dirname(path); dir !== "."; dir = dirname(dir))
    await rmdir(await inside(directory, dir)).catch(() => undefined);
}

/**
 * `luciole skills status`: each skill and the block, per target. Resolves with the exit code:
 * `STALE_EXIT_CODE` when anything is stale or missing, so CI can use it.
 */
export async function statusSkills(options: SkillsOptions): Promise<number> {
  const desired = await desiredFiles(options);
  const skills = [...new Set([...desired.keys()].map((path) => path.split("/")[0] ?? path))];
  let behind = false;
  const report = (where: string, what: string, state: State) => {
    if (state === "stale" || state === "missing") behind = true;
    options.log(`${where.padEnd(WHERE_WIDTH)} ${what.padEnd(WHAT_WIDTH)} ${LABEL[state]}`);
  };
  const manifests = await Promise.all(targetsOf(options, options.agents).map(readManifest));
  const targets = targetsOf(options, options.agents);
  for (const [index, target] of targets.entries()) {
    const manifest = manifests[index];
    for (const skill of skills) {
      const paths = [...desired.keys()].filter((path) => path.startsWith(`${skill}/`));
      if (!manifest?.files && (await existsIn(target.directory, skill))) {
        report(target.label, skill, "foreign");
        continue;
      }
      const states = await Promise.all(
        paths.map(async (path) =>
          fileState(
            await readIn(target.directory, path),
            desired.get(path) ?? new Uint8Array(),
            manifest?.files[path],
          ),
        ),
      );
      report(target.label, skill, WORST.find((state) => states.includes(state)) ?? "current");
    }
  }
  if (!options.global) {
    const all = (await Promise.all(targetsOf(options, AGENTS).map(readManifest))).flatMap(
      (m) => m ?? [],
    );
    const block = await blockState(options, all.find((m) => m.block !== undefined)?.block);
    report("AGENTS.md", "luciole block", block.state);
    report("CLAUDE.md", "imports AGENTS.md", (await importState(options)).state);
  }
  if (behind)
    options.warn(
      `Stale or missing: run luciole skills to update. Exit code ${STALE_EXIT_CODE} (STALE_EXIT_CODE).`,
    );
  return behind ? STALE_EXIT_CODE : 0;
}

/** `luciole skills remove`: deletes what luciole wrote and the user has not modified. */
export async function removeSkills(options: SkillsOptions): Promise<void> {
  const verb = options.dryRun ? "would have " : "";
  const log = (line: string) => options.log(`${verb}${line}`);
  const all = targetsOf(options, AGENTS);
  const targets = targetsOf(options, options.agents);
  // The block goes with the whole material, not with one agent's skills.
  const wholly = options.global || options.agents.length === AGENTS.length;
  let blockKept = false;
  let touched = false;

  // Nothing is deleted before every path the manifests name has passed the gate.
  for (const target of targets) {
    const recorded = await readManifest(target);
    for (const path of Object.keys(recorded?.files ?? {})) await inside(target.directory, path);
  }
  if (!options.global && wholly) {
    const manifests = (await Promise.all(all.map(readManifest))).flatMap((m) => m ?? []);
    const block = await blockState(options, manifests.find((m) => m.block !== undefined)?.block);
    if (block.at && block.text !== undefined) {
      if (block.state === "modified" && !options.force) {
        blockKept = true;
        options.warn(
          `${shown(options, block.file)}: the luciole block was modified locally, left alone (--force removes it)`,
        );
      } else {
        const rest = without(block.text, block.at);
        touched = true;
        log(`removed the luciole block from ${shown(options, block.file)}`);
        if (!options.dryRun) {
          if (rest.trim() === "") await rm(block.file, { force: true });
          else await writeFile(block.file, rest);
        }
      }
    }
    const claude = join(options.directory, "CLAUDE.md");
    const text = await readText(claude);
    const at = text === undefined ? undefined : locate(text, IMPORT_BEGIN, IMPORT_END, claude);
    if (text !== undefined && at) {
      const rest = without(text, at);
      touched = true;
      log("removed the AGENTS.md import from CLAUDE.md");
      if (!options.dryRun) {
        if (rest.trim() === "") await rm(claude, { force: true });
        else await writeFile(claude, rest);
      }
    }
  }

  for (const target of targets) {
    const manifest = await readManifest(target);
    if (!manifest) continue;
    const files: Record<string, string> = {};
    for (const [path, owned] of Object.entries(manifest.files)) {
      const disk = await readIn(target.directory, path);
      if (!disk) continue;
      if (hash(disk) === owned || options.force) {
        touched = true;
        log(`removed ${target.label}/${path}`);
        if (!options.dryRun) await removeFile(target.directory, path);
      } else {
        files[path] = owned;
        options.warn(`${target.label}/${path}: modified locally, left alone (--force removes it)`);
      }
    }
    if (options.dryRun) continue;
    const manifestFile = await inside(target.directory, MANIFEST_FILE);
    const keep = Object.keys(files).length > 0 || (blockKept && manifest.block !== undefined);
    if (keep) {
      const { block, ...rest } = manifest;
      await writeFile(
        manifestFile,
        manifestText({ ...rest, files, ...(blockKept && block ? { block } : {}) }),
      );
    } else {
      await rm(manifestFile, { force: true });
      // Created by luciole once empty: the skills directory, then the agent's own.
      await rmdir(target.directory).catch(() => undefined);
      await rmdir(dirname(target.directory)).catch(() => undefined);
    }
  }
  if (!touched) options.log("nothing to remove");
}

const SUBCOMMANDS: readonly string[] = ["install", "status", "remove"];

/** The agents a `--agent` list names; absent, all of them. */
export function parseAgents(list: string | undefined): Agent[] {
  if (list === undefined) return [...AGENTS];
  const names = list.split(",").map((each) => each.trim());
  const bad = names.find((name) => !isAgent(name));
  if (bad !== undefined || names.length === 0)
    throw new ArgsError(
      `--agent takes ${AGENTS.join(", ")} (a comma-separated list), not ${bad ?? list}`,
    );
  return AGENTS.filter((agent) => names.includes(agent));
}

export const skills: Command = {
  usage:
    "skills [install | status | remove] [--app dir] [--global] [--agent agents,claude] [--dry-run] [--force]",
  flags: {
    "--app": "value",
    "--global": "switch",
    "--agent": "value",
    "--dry-run": "switch",
    "--force": "switch",
  },
  async run({ args, flag, optional, directory }) {
    const word = args[1] && !args[1].startsWith("-") ? args[1] : "install";
    if (!SUBCOMMANDS.some((each) => each === word))
      throw new ArgsError(`Unknown skills command ${word} (install, status or remove)`);
    const agents = parseAgents(optional("--agent"));
    const options: SkillsOptions = {
      ...(await packagedMaterial()),
      directory,
      home: homedir(),
      global: flag("--global"),
      agents,
      dryRun: flag("--dry-run"),
      force: flag("--force"),
      log: (line) => console.log(line),
      warn: (line) => console.error(line),
    };
    try {
      if (word === "install") await installSkills(options);
      else if (word === "remove") await removeSkills(options);
      else process.exitCode = await statusSkills(options);
    } catch (error) {
      if (error instanceof ArgsError) throw error;
      throw new Error(messageOf(error), { cause: error });
    }
  },
};

/** Whether `CI` says this is a pipeline: set, and not one of the usual ways to say it is not. */
const inPipeline = (env: Record<string, string | undefined>) =>
  !["", "0", "false", undefined].includes(env.CI);

/**
 * A line for stderr when the skills installed in the app come from another version of luciole
 * than the one running, or `undefined`: nothing installed, in a pipeline, or unreadable. It
 * never throws and never changes an exit code; `dev` and `build` print it.
 */
export async function staleNotice(
  directory: string,
  version?: string,
  env: Record<string, string | undefined> = process.env,
): Promise<string | undefined> {
  if (inPipeline(env)) return undefined;
  try {
    const current = version ?? (await packagedMaterial()).version;
    const targets = AGENTS.map((agent) => ({
      label: agent,
      directory: join(directory, AGENT_DIRECTORIES[agent]),
    }));
    const manifests = (await Promise.all(targets.map(readManifest))).flatMap((each) => each ?? []);
    const old = manifests.find((each) => each.version !== current);
    return old
      ? `luciole: the agent skills in this app are from luciole ${old.version}, this is ${current}: run luciole skills to update them`
      : undefined;
  } catch {
    return undefined;
  }
}

export const printStaleNotice = async (directory: string) => {
  const notice = await staleNotice(directory);
  if (notice) console.error(notice);
};
