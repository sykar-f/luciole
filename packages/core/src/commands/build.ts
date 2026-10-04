import { rename, rm } from "node:fs/promises";
import { basename, dirname, join, relative, resolve } from "node:path";
import { ArgsError } from "../args";
import { build as buildApplication } from "../build";
import { compileApp, compileClient } from "../compile";
import { publisherIdentity, readPublisherKey } from "../publisher";
import { installWebRuntime } from "../web-runtime";
import type { Command } from "./command";
// What only `--compile` reads: given without it, they would be dropped in silence.
const COMPILE_FLAGS = {
  "--name": "value",
  "--client-only": "switch",
  "--target": "value",
  "--runtime": "value",
  "--portable": "switch",
  "--native-dir": "value",
  "--outfile": "value",
  "--sign": "value",
  "--notarize": "value",
} as const;
/** Where a binary bound for `outfile` is staged: beside it, so the last move is a rename. */
const stagingName = (outfile: string) =>
  join(dirname(outfile), `.staging-${crypto.randomUUID()}-${basename(outfile)}`);
/** Bun appends `.exe` to a Windows target's outfile when it lacks it. */
async function moveStaged(staged: string, outfile: string) {
  if (await Bun.file(staged).exists()) return rename(staged, outfile);
  return rename(`${staged}.exe`, outfile.endsWith(".exe") ? outfile : `${outfile}.exe`);
}
export const build: Command = {
  usage:
    "build [--app dir] [--app-bundle] [--sign-bundle] [--web | --web-local] [--compile [--name n] [--client-only] [--target t] [--runtime official|host|<bun>] [--portable] [--native-dir dir] [--outfile f] [--sign identity [--notarize profile]]]",
  flags: {
    "--app": "value",
    "--app-bundle": "switch",
    "--sign-bundle": "switch",
    "--web": "switch",
    "--web-local": "switch",
    "--compile": "switch",
    ...COMPILE_FLAGS,
  },
  async run({ flag, optional, directory }) {
    // Every flag is read first: a missing value fails before a long build.
    if (!flag("--compile")) {
      const stray = Object.keys(COMPILE_FLAGS).find(flag);
      if (stray) throw new ArgsError(`${stray} only applies with --compile`);
    }
    const compile = flag("--compile")
      ? {
          name: optional("--name") ?? basename(directory),
          target: optional("--target"),
          outfile: optional("--outfile"),
          runtime: optional("--runtime"),
          portable: flag("--portable"),
          nativeDir: optional("--native-dir"),
          sign: optional("--sign"),
          notarize: optional("--notarize"),
        }
      : undefined;
    const clientOnly = flag("--client-only");
    // --sign-bundle: the publisher key (`luciole keys`), read before a long build fails on it.
    const signBundle = flag("--sign-bundle") ? readPublisherKey() : undefined;
    // --app-bundle: the application must be embeddable (.luciole/app), or the build fails.
    // --web: browsers open the application from its Server (docs/WEB.md), so it needs its
    // bundle, and this ABI's web runtime next to it. --web-local: a static site where the
    // Server runs in the browser too.
    const local = flag("--web-local");
    const web = local || flag("--web");
    // Everything is staged with the build and published with it: a failing --web or
    // --compile leaves the previous build in place. A binary written outside the build
    // (--outfile) is staged beside its destination and moved over the previous one last.
    const staging: {
      directory?: string;
      web?: string;
      compiled?: Awaited<ReturnType<typeof compileClient>>;
      outside?: { outfile: string; staged: string };
    } = {};
    const stage = async (directory: string) => {
      staging.directory = directory;
      if (web) staging.web = await installWebRuntime(directory, { local });
      if (!compile) return;
      if (compile.outfile) {
        const outfile = resolve(compile.outfile);
        staging.outside = { outfile, staged: stagingName(outfile) };
      }
      // The app binary holds the Server too (src/launcher/binary.ts); --client-only keeps
      // it out of what the terminal's machine receives.
      staging.compiled = await (clientOnly ? compileClient : compileApp)(directory, {
        ...compile,
        outfile: staging.outside?.staged,
      });
    };
    try {
      const result = await buildApplication(directory, undefined, {
        appBundle: flag("--app-bundle") || web ? "required" : "auto",
        signBundle,
        webServer: local,
        // An up-to-date build stages too, on a copy of the output already there.
        stage: web || compile ? stage : undefined,
      });
      const { directory: staged = result.output, compiled, outside } = staging;
      if (outside) await moveStaged(outside.staged, outside.outfile);
      // Where a staged file ended up: the staging directory became `result.output`.
      const published = (file: string) => join(result.output, relative(staged, file));
      if (staging.web) console.log({ web: published(staging.web) });
      if (signBundle)
        console.log({
          signedBundle: publisherIdentity(signBundle).fingerprint,
        });
      console.log(result);
      if (!compiled) return;
      const outfile = outside ? outside.outfile : published(compiled.outfile);
      console.log({
        [clientOnly ? "client" : "binary"]: outfile,
        target: compiled.target,
        ...(compiled.notarization ? { notarization: compiled.notarization } : {}),
      });
      if (compiled.warning) console.error(`Warning: ${compiled.warning}`);
      if (!clientOnly)
        console.error(
          `Warning: ${outfile} contains the Server, your business code included, as well as ` +
            "the Client: whoever receives it can read that code. For users who must only " +
            "connect to your Server, build with --client-only.",
        );
    } finally {
      if (staging.outside) {
        await rm(staging.outside.staged, { force: true });
        await rm(`${staging.outside.staged}.exe`, { force: true });
      }
    }
  },
};
