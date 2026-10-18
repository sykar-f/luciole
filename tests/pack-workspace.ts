import { cp, symlink } from "node:fs/promises";
import { join, relative, resolve } from "node:path";

/**
 * A private checkout for package lifecycle scripts: declarations, docs and the starter
 * template must never share output with another test's pack. Copy only tracked inputs,
 * so live build locks and generated output cannot enter a tarball. Dependencies and Git
 * metadata are read through links; lifecycle scripts write only into the copied sources.
 * The caller owns `destination` and removes it with its temporary test directory.
 */
export async function copyPackWorkspace(destination: string): Promise<string> {
  const source = resolve(import.meta.dir, "..");
  const listed = Bun.spawn(["git", "ls-files", "-z"], {
    cwd: source,
    stdout: "pipe",
    stderr: "inherit",
  });
  const files = (await new Response(listed.stdout).text()).split("\0").filter(Boolean);
  if ((await listed.exited) !== 0) throw new Error("Cannot list the checkout's pack inputs");
  const tracked = new Set([""]);
  for (const file of files) {
    const parts = file.split("/");
    for (let end = 1; end <= parts.length; end++) tracked.add(parts.slice(0, end).join("/"));
  }
  await cp(source, destination, {
    recursive: true,
    filter: (path) => tracked.has(relative(source, path)),
  });
  await symlink(join(source, "node_modules"), join(destination, "node_modules"), "dir");
  // Docs pin source links to this revision even though the sources are in a private copy.
  await symlink(join(source, ".git"), join(destination, ".git"));
  return destination;
}
