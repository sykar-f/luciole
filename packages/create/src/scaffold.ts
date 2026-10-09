import { cp, mkdir, readdir, rename } from "node:fs/promises";
import { join, sep } from "node:path";

/**
 * The template's `.gitignore`, as the tarball holds it: npm drops files of that name when it
 * packs, so the staging step (scripts/stage.ts) renames it and the scaffold renames it back.
 */
export const PACKED_GITIGNORE = "gitignore";

/** Writes the staged starter into `target`, which must be absent or empty. */
export async function scaffold(options: {
  template: string;
  target: string;
  skills?: boolean;
}): Promise<void> {
  const { template, target, skills = true } = options;
  if (!(await readdir(template).catch((): string[] => [])).length)
    throw new Error(`${template}: no staged template (run bun scripts/stage.ts in the repository)`);
  if ((await readdir(target).catch((): string[] => [])).length)
    throw new Error("Target already contains a project");
  await mkdir(target, { recursive: true });
  await cp(template, target, {
    recursive: true,
    filter: (path) =>
      skills ||
      ![".agents", ".claude", "AGENTS.md", "CLAUDE.md"].some(
        (name) => path === join(template, name) || path.startsWith(join(template, name) + sep),
      ),
  });
  await rename(join(target, PACKED_GITIGNORE), join(target, ".gitignore"));
}
