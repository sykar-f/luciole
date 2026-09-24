/**
 * What an installed build is: `<app>` and the files it needs, plus `SHA256SUMS`, the
 * `sha256sum -c` list of all of them. It is written once per install and checked on every
 * launch (remotely by `--on`): a damaged or altered file is never used silently.
 */
import { cp, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";

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

/** A tar of `<app>` (from `binary`) and its SHA256SUMS, ready to extract in place. */
export async function packBundle(app: string, binary: string) {
  const staging = await mkdtemp(join(tmpdir(), "airtty-bundle-"));
  try {
    await cp(binary, join(staging, app));
    await writeFile(join(staging, SUMS), await checksums(staging));
    // macOS tar would add AppleDouble files for extended attributes.
    const tar = Bun.spawnSync(["tar", "cf", "-", "-C", staging, "."], {
      env: { ...process.env, COPYFILE_DISABLE: "1" },
    });
    if (tar.exitCode !== 0) throw new Error(`tar: ${tar.stderr.toString()}`);
    return new Uint8Array(tar.stdout);
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}
