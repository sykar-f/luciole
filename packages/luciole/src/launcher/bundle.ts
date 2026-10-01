/**
 * What an installed build is: `<app>` and the files it needs, plus `SHA256SUMS`, the
 * `sha256sum -c` list of all of them. It is written once per install and checked on every
 * launch (remotely by `--on`): a damaged or altered file is never used silently.
 */
import { cp, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { NATIVE_DIRECTORY, nativeTarget } from "../native";
import { run } from "../subprocess";

export const SUMS = "SHA256SUMS";

async function files(directory: string): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true, recursive: true }))
    if (entry.isFile()) found.push(relative(directory, join(entry.parentPath, entry.name)));
  return found.sort();
}

/** `sha256sum` lines for every file under `directory`, SHA256SUMS itself excluded. */
export async function checksums(directory: string) {
  const lines: string[] = [];
  for (const file of await files(directory)) {
    if (file === SUMS) continue;
    const hash = new Bun.CryptoHasher("sha256")
      .update(await Bun.file(join(directory, file)).bytes())
      .digest("hex");
    lines.push(`${hash}  ${file}`);
  }
  return lines.join("\n") + "\n";
}

/**
 * A tar of `<app>` (from `binary`), the `native/` next to it when there is one, and their
 * SHA256SUMS, ready to extract in place.
 */
export async function packBundle(app: string, binary: string, target: string) {
  const staging = await mkdtemp(join(tmpdir(), "luciole-bundle-"));
  try {
    await cp(binary, join(staging, app));
    const native = join(dirname(binary), NATIVE_DIRECTORY);
    const nativeFor = nativeTarget(native);
    if (nativeFor !== undefined) {
      if (nativeFor !== target)
        throw new Error(`${native} is for ${nativeFor}, not ${target}: next to the wrong binary`);
      await cp(native, join(staging, NATIVE_DIRECTORY), { recursive: true, dereference: true });
    }
    await writeFile(join(staging, SUMS), await checksums(staging));
    // macOS tar would add AppleDouble files for extended attributes.
    const tar = await run(["tar", "cf", "-", "-C", staging, "."], {
      env: { ...process.env, COPYFILE_DISABLE: "1" },
    });
    if (tar.exitCode !== 0) throw new Error(`tar: ${tar.stderr}`);
    return tar.stdout;
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}
