/**
 * Signs and notarizes a macOS Client binary, so that Gatekeeper lets it run once it has
 * been downloaded. Nothing here runs unless the build asks for it (`--sign`, `--notarize`).
 */
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { z } from "zod";

export type SignOptions = {
  /** codesign identity: "Developer ID Application: …" to distribute, "-" for ad hoc. */
  sign?: string;
  /** notarytool keychain profile (`xcrun notarytool store-credentials <profile>`). */
  notarize?: string;
};

/**
 * The hardened runtime forbids what Bun needs; these are its only two exceptions, both
 * measured on a Client binary: without allow-jit Bun traps, and bun:ffi, which loads
 * OpenTUI, "requires the JIT"; without disable-library-validation dlopen refuses OpenTUI's
 * library, extracted to $TMPDIR at launch and not signed by the application's team.
 */
export const ENTITLEMENTS = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>com.apple.security.cs.allow-jit</key>
  <true/>
  <key>com.apple.security.cs.disable-library-validation</key>
  <true/>
</dict>
</plist>
`;

/** Rejects impossible requests before anything is built or downloaded. */
export function checkSigning(target: string, { sign, notarize }: SignOptions) {
  if (sign === undefined && notarize === undefined) return;
  if (!target.startsWith("bun-darwin-"))
    throw new Error(`--sign and --notarize apply to macOS targets, not ${target}`);
  if (process.platform !== "darwin")
    throw new Error("--sign and --notarize need macOS (codesign, notarytool)");
  if (notarize !== undefined && (sign === undefined || sign === "-"))
    throw new Error(
      '--notarize needs --sign "Developer ID Application: …": Apple does not notarize ad hoc signatures',
    );
}

function run(command: string[]) {
  const result = Bun.spawnSync(command, { stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0)
    throw new Error(
      `${command.slice(0, 2).join(" ")} failed:\n${result.stderr.toString()}${result.stdout.toString()}`,
    );
  return result.stdout.toString();
}

async function inTemporary<T>(use: (dir: string) => Promise<T>) {
  const dir = await mkdtemp(join(tmpdir(), "airtty-sign-"));
  try {
    return await use(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** Replaces the linker's ad hoc signature: hardened runtime, entitlements, timestamp. */
export function signClient(outfile: string, identity: string) {
  return inTemporary(async (dir) => {
    const entitlements = join(dir, "entitlements.plist");
    await Bun.write(entitlements, ENTITLEMENTS);
    run([
      "codesign",
      "--force",
      "--options",
      "runtime",
      "--entitlements",
      entitlements,
      // Notarization requires a secure timestamp; an ad hoc signature cannot have one.
      ...(identity === "-" ? [] : ["--timestamp"]),
      "--sign",
      identity,
      outfile,
    ]);
    run(["codesign", "--verify", "--strict", "--verbose=2", outfile]);
  });
}

/** What `notarytool submit --output-format json` reports; anything else is no verdict. */
const Submission = z.object({ id: z.string().optional(), status: z.string().optional() });

/**
 * Submits the signed binary to Apple and waits for the verdict. notarytool takes a zip,
 * not a bare executable, and stapler cannot attach a ticket to one: Gatekeeper fetches
 * the ticket online on the first launch.
 */
export function notarizeClient(outfile: string, profile: string) {
  return inTemporary(async (dir) => {
    const archive = join(dir, `${basename(outfile)}.zip`);
    run(["ditto", "-c", "-k", "--keepParent", outfile, archive]);
    const profileArgs = ["--keychain-profile", profile];
    const submission: unknown = JSON.parse(
      run([
        "xcrun",
        "notarytool",
        "submit",
        archive,
        ...profileArgs,
        "--wait",
        "--output-format",
        "json",
      ]),
    );
    const parsed = Submission.safeParse(submission);
    const { id, status } = parsed.success ? parsed.data : {};
    if (id && status === "Accepted") return id;
    const log = id ? run(["xcrun", "notarytool", "log", id, ...profileArgs]) : "";
    throw new Error(
      `Notarization ${id ?? "submission"} ended with ${status ?? "no status"}\n${log}`,
    );
  });
}
