import { basename } from "node:path";
import { build as buildApplication } from "../build";
import { compileApp, compileClient } from "../compile";
import type { Command } from "./command";
export const build: Command = {
  usage:
    "build [--compile [--name n] [--client-only] [--target t] [--runtime official|host|<bun>] [--native-dir dir] [--outfile f] [--sign identity [--notarize profile]]]",
  async run({ args, optional, directory }) {
    // Every flag is read first: a missing value fails before a long build.
    const compile = args.includes("--compile")
      ? {
          name: optional("--name") ?? basename(directory),
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
    // The app binary holds the Server too (src/launcher/binary.ts); --client-only keeps
    // it out of what the terminal's machine receives.
    const clientOnly = args.includes("--client-only");
    const compiled = await (clientOnly ? compileClient : compileApp)(result.output, compile);
    console.log({
      [clientOnly ? "client" : "binary"]: compiled.outfile,
      target: compiled.target,
      ...(compiled.notarization ? { notarization: compiled.notarization } : {}),
    });
    if (compiled.warning) console.error(`Warning: ${compiled.warning}`);
    if (!clientOnly)
      console.error(
        `Warning: ${compiled.outfile} contains the Server, your business code included, as ` +
          "well as the Client: whoever receives it can read that code. For users who must " +
          "only connect to your Server, build with --client-only.",
      );
  },
};
