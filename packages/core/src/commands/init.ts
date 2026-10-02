import { join, resolve } from "node:path";
import { cp, mkdir, readdir } from "node:fs/promises";
import { z } from "zod";
import { readJsonFile, readPackageJson } from "../package-json";
import { canGreet, mascotArt } from "../mascot";
import { frameworkRoot, workspaceRoot, type Command } from "./command";
/** The formatter options a starter's generated JSON files follow. */
const FormatterConfig = z.object({
  printWidth: z.number().int().positive(),
  sortImports: z.boolean(),
  sortPackageJson: z.boolean(),
});
export const init: Command = {
  usage: "init <dir>",
  async run({ args }) {
    const target = resolve(args[1] ?? "my-luciole-app");
    if ((await readdir(target).catch((): string[] => [])).length)
      throw new Error("Target already contains a project");
    await mkdir(target, { recursive: true });
    await cp(join(workspaceRoot, "examples/notes"), target, {
      recursive: true,
      filter: (p) =>
        !p.includes(".luciole") &&
        !p.endsWith(".sqlite") &&
        !p.endsWith(".sqlite-wal") &&
        !p.endsWith(".sqlite-shm"),
    });
    const frameworkPackage = await readPackageJson(join(frameworkRoot, "package.json"));
    const notesPackage = await readPackageJson(join(workspaceRoot, "examples/notes/package.json"));
    // A starter is no workspace member: `catalog:` becomes the version the workspace pins.
    const catalog =
      (await readPackageJson(join(workspaceRoot, "package.json"))).workspaces?.catalog ?? {};
    const pinned = (dependencies: Record<string, string> = {}) =>
      Object.fromEntries(
        Object.entries(dependencies).map(([name, range]) => {
          if (range !== "catalog:") return [name, range];
          const version = catalog[name];
          if (!version) throw new Error(`${name}: catalog: without a version in the workspace`);
          return [name, version];
        }),
      );
    await Bun.write(
      join(target, "package.json"),
      JSON.stringify(
        {
          private: true,
          type: "module",
          packageManager: frameworkPackage.packageManager,
          dependencies: {
            ...pinned(notesPackage.dependencies),
            "@luciole-sh/core": `file:${frameworkRoot}`,
          },
          devDependencies: pinned(frameworkPackage.devDependencies),
          overrides: frameworkPackage.overrides,
          scripts: {
            dev: "luciole dev --app .",
            build: "luciole build --app .",
            // Not a bare `tsc`: `.bin/tsc` is TypeScript 6's, from `@typescript/old`.
            check: "bun node_modules/typescript/bin/tsc --noEmit",
            lint: "oxlint --deny-warnings .",
            "lint:fix": "oxlint --fix .",
            format: "oxfmt --write .",
            "format:check": "oxfmt --check .",
            verify: "bun run check && bun run lint && bun run format:check && bun run build",
          },
        },
        null,
        2,
      ),
    );
    await Bun.write(
      join(target, "tsconfig.json"),
      JSON.stringify(
        {
          extends: "@luciole-sh/core/tsconfig",
          include: ["app", "components", "actions", "server"],
          exclude: ["node_modules", ".luciole"],
        },
        null,
        2,
      ) + "\n",
    );
    for (const file of [
      ".oxlintrc.json",
      ".oxfmtrc.json",
      ".vscode",
      ".gitignore",
      ".bun-version",
    ]) {
      await cp(join(workspaceRoot, file), join(target, file), { recursive: true });
    }
    const { format } = await import("oxfmt");
    const { printWidth, sortImports, sortPackageJson } = await readJsonFile(
      join(workspaceRoot, ".oxfmtrc.json"),
      FormatterConfig,
    );
    for (const name of ["package.json", "tsconfig.json"]) {
      const file = Bun.file(join(target, name));
      const result = await format(name, await file.text(), {
        printWidth,
        sortImports,
        sortPackageJson,
      });
      if (result.errors.length) throw new Error(`Cannot format generated ${name}`);
      await Bun.write(file, result.code);
    }
    console.log(`Starter created: ${target}\nRun bun install in the starter, then bun run dev.`);
    // The useful lines first; the picture is a greeting, for a person at a colour terminal.
    if (canGreet(process.stdout, process.env)) console.log(`\n${mascotArt()}`);
  },
};
