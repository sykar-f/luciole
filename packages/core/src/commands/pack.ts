import { resolve } from "node:path";
import { ArgsError } from "../args";
import { packApp } from "../registry/pack";
import type { Command } from "./command";
export const pack: Command = {
  usage: "pack --package <npm name> --version <v> [--description d] [--outdir dir] <binary>…",
  flags: {
    "--package": "value",
    "--version": "value",
    "--description": "value",
    "--outdir": "value",
  },
  async run({ args, optional }) {
    const binaries = args
      .slice(1)
      .filter(
        (arg, i, all) => !arg.startsWith("--") && !Object.hasOwn(pack.flags, all[i - 1] ?? ""),
      );
    const name = optional("--package"),
      version = optional("--version");
    if (!name || !version || !binaries.length) throw new ArgsError(`Usage: luciole ${pack.usage}`);
    const directories = await packApp({
      package: name,
      version,
      description: optional("--description"),
      binaries: binaries.map((binary) => resolve(binary)),
      outdir: resolve(optional("--outdir") ?? "npm"),
    });
    console.log(
      `Publish in this order (platforms first):\n${directories.map((d) => `  npm publish ${d}`).join("\n")}`,
    );
  },
};
