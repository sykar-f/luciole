import { join, resolve } from "node:path";
import { cp, mkdir, readdir } from "node:fs/promises";
import { z } from "zod";
import { readJsonFile, readPackageJson } from "../package-json";
import { frameworkRoot, type Command } from "./command";
/** The formatter options a starter's generated JSON files follow. */
const FormatterConfig = z.object({
  printWidth: z.number().int().positive(),
  sortImports: z.boolean(),
  sortPackageJson: z.boolean(),
});
export const init: Command = {
  usage: "init <dir>",
  async run({ args }) {
    const target = resolve(args[1] ?? "my-airtty-app");
    if ((await readdir(target).catch((): string[] => [])).length)
      throw new Error("Target already contains a project");
    await mkdir(target, { recursive: true });
    await cp(join(frameworkRoot, "examples/notes"), target, {
      recursive: true,
      filter: (p) =>
        !p.includes(".airtty") &&
        !p.endsWith(".sqlite") &&
        !p.endsWith(".sqlite-wal") &&
        !p.endsWith(".sqlite-shm"),
    });
    const frameworkPackage = await readPackageJson(join(frameworkRoot, "package.json"));
    await Bun.write(
      join(target, "package.json"),
      JSON.stringify(
        {
          private: true,
          type: "module",
          packageManager: frameworkPackage.packageManager,
          dependencies: {
            ...frameworkPackage.dependencies,
            airtty: `file:${frameworkRoot}`,
          },
          devDependencies: frameworkPackage.devDependencies,
          overrides: frameworkPackage.overrides,
          scripts: {
            dev: "airtty dev --app .",
            build: "airtty build --app .",
            check: "tsc --noEmit",
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
          extends: "airtty/tsconfig",
          include: ["app", "components", "actions", "server"],
          exclude: ["node_modules", ".airtty"],
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
      await cp(join(frameworkRoot, file), join(target, file), { recursive: true });
    }
    const { format } = await import("oxfmt");
    const { printWidth, sortImports, sortPackageJson } = await readJsonFile(
      join(frameworkRoot, ".oxfmtrc.json"),
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
  },
};
