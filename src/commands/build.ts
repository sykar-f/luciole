import { basename } from "node:path";
import { build as buildApplication } from "../build";
import { compileClient } from "../compile";
import type { Command } from "./command";
export const build: Command = {
  usage:
    "build [--compile [--target t] [--runtime official|host|<bun>] [--native-dir dir] [--outfile f] [--sign identity [--notarize profile]]]",
  async run({ args, optional, directory }) {
    // Every flag is read first: a missing value fails before a long build.
    const compile = args.includes("--compile")
      ? {
          name: basename(directory),
          target: optional("--target"),
          outfile: optional("--outfile"),
          runtime: optional("--runtime"),
          nativeDir: optional("--native-dir"),
          sign: optional("--sign"),
          notarize: optional("--notarize"),
        }
      : undefined;
    const result = await buildApplication(directory);
    console.log(result);
    if (!compile) return;
    const compiled = await compileClient(result.output, compile);
    console.log({
      client: compiled.outfile,
      target: compiled.target,
      ...(compiled.notarization ? { notarization: compiled.notarization } : {}),
    });
    if (compiled.warning) console.error(`Warning: ${compiled.warning}`);
  },
};
