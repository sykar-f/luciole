import { basename } from "node:path";
import { build as buildApplication } from "../build";
import { compileApp, compileClient } from "../compile";
import { publisherIdentity, readPublisherKey } from "../publisher";
import { installWebRuntime } from "../web-runtime";
import type { Command } from "./command";
export const build: Command = {
  usage:
    "build [--app-bundle] [--sign-bundle] [--web | --web-local] [--compile [--name n] [--client-only] [--target t] [--runtime official|host|<bun>] [--portable] [--native-dir dir] [--outfile f] [--sign identity [--notarize profile]]]",
  async run({ flag, optional, directory }) {
    // Every flag is read first: a missing value fails before a long build.
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
    // --sign-bundle: the publisher key (`luciole keys`), read before a long build fails on it.
    const signBundle = flag("--sign-bundle") ? readPublisherKey() : undefined;
    // --app-bundle: the application must be embeddable (.luciole/app), or the build fails.
    // --web: browsers open the application from its Server (docs/WEB.md), so it needs its
    // bundle, and this ABI's web runtime next to it. --web-local: a static site where the
    // Server runs in the browser too.
    const local = flag("--web-local");
    const web = local || flag("--web");
    const result = await buildApplication(directory, undefined, {
      appBundle: flag("--app-bundle") || web ? "required" : "auto",
      signBundle,
      webServer: local,
    });
    if (web) console.log({ web: await installWebRuntime(result.output, { local }) });
    if (signBundle) console.log({ signedBundle: publisherIdentity(signBundle).fingerprint });
    console.log(result);
    if (!compile) return;
    // The app binary holds the Server too (src/launcher/binary.ts); --client-only keeps
    // it out of what the terminal's machine receives.
    const clientOnly = flag("--client-only");
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
