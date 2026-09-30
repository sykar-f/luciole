/**
 * Where the in-browser Server keeps its databases between visits (docs/WEB.md, § 3 and
 * decision 2): one file per database in the origin's private file system (OPFS), under the
 * application's name. Read whole before the application's Server code runs (a Database
 * opens synchronously), written whole after every Server Function.
 */
const ROOT = "luciole";

async function directory(app: string) {
  const root = await navigator.storage.getDirectory();
  return (await root.getDirectoryHandle(ROOT, { create: true })).getDirectoryHandle(app, {
    create: true,
  });
}
const fileName = (database: string) => encodeURIComponent(database);

/** Every database image stored for `app`, by database name. */
export async function readSnapshots(app: string): Promise<Map<string, Uint8Array>> {
  const snapshots = new Map<string, Uint8Array>();
  const dir = await directory(app);
  for await (const [name, handle] of dir.entries())
    if (handle.kind === "file")
      snapshots.set(
        decodeURIComponent(name),
        new Uint8Array(await (await handle.getFile()).arrayBuffer()),
      );
  return snapshots;
}

/** Replaces the stored image of `database`: whole, or not at all if interrupted. */
export async function writeSnapshot(app: string, database: string, bytes: Uint8Array<ArrayBuffer>) {
  const file = await (await directory(app)).getFileHandle(fileName(database), { create: true });
  const writable = await file.createWritable();
  await writable.write(bytes);
  await writable.close();
}
