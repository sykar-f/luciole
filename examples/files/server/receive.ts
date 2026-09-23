import { constants } from "node:fs";
import { copyFile, link, lstat, open, unlink, writeFile } from "node:fs/promises";
import { basename, isAbsolute, join } from "node:path";
import { createHash } from "node:crypto";
import { z } from "zod";
import {
  COPY_MAX_BYTES,
  FINGERPRINT_BYTES,
  type Fingerprint,
  type ReceiveResult,
} from "../components/model";
import { inside } from "./fs";

// The only writes of the explorer: a file dropped on the terminal lands in the directory
// on screen. `FILES_READ_ONLY=1` turns them off. Nothing is ever overwritten.
const ReadOnlySchema = z.enum(["0", "1"]).optional();
export const readOnly = ReadOnlySchema.parse(process.env.FILES_READ_ONLY) === "1";

const exists = async (path: string) => (await lstat(path).catch(() => null)) !== null;
const errno = (error: unknown) => z.object({ code: z.string() }).safeParse(error).data?.code;

async function destination(directory: string, name: string) {
  const target = await inside(directory);
  if (!target || !(await lstat(target)).isDirectory()) return null;
  if (!name || name !== basename(name) || name === "." || name === "..") return null;
  return join(target, name);
}

async function headHash(path: string) {
  const file = await open(path, "r");
  try {
    const buffer = new Uint8Array(FINGERPRINT_BYTES);
    const { bytesRead } = await file.read(buffer, 0, FINGERPRINT_BYTES, 0);
    return createHash("sha256").update(buffer.subarray(0, bytesRead)).digest("hex");
  } finally {
    await file.close();
  }
}

/**
 * The Server is on the terminal's machine when it sees the very file the Client saw:
 * same device, inode, size, date and first MiB. A path alone proves nothing (the same
 * path may exist on both machines), so a remote Client always ends up copying.
 */
async function sameFile(source: Fingerprint) {
  if (!isAbsolute(source.path)) return false;
  const info = await lstat(source.path).catch(() => null);
  return (
    info !== null &&
    info.isFile() &&
    info.dev === source.dev &&
    info.ino === source.ino &&
    info.size === source.size &&
    info.mtimeMs === source.modified &&
    (await headHash(source.path)) === source.sha256
  );
}

/** Moves the dropped file into `directory` when this machine has it. */
export async function receive(
  directory: string,
  name: string,
  source: Fingerprint,
): Promise<ReceiveResult> {
  if (readOnly) return { ok: false, reason: "read-only" };
  const target = await destination(directory, name);
  if (!target) return { ok: false, reason: "invalid" };
  if (await exists(target)) return { ok: false, reason: "exists" };
  if (!(await sameFile(source))) return { ok: false, reason: "not-local" };
  try {
    // A hard link never replaces an existing name: no race with a file created meanwhile.
    await link(source.path, target);
  } catch (error: unknown) {
    const code = errno(error);
    if (code === "EEXIST") return { ok: false, reason: "exists" };
    // Another file system (or one without hard links): copy, still without overwriting.
    if (code !== "EXDEV" && code !== "EPERM" && code !== "ENOTSUP") throw error;
    try {
      await copyFile(source.path, target, constants.COPYFILE_EXCL);
    } catch (copyError: unknown) {
      if (errno(copyError) === "EEXIST") return { ok: false, reason: "exists" };
      throw copyError;
    }
  }
  await unlink(source.path);
  return { ok: true, mode: "moved", name };
}

/** Writes the bytes a remote Client sent, as a new file of `directory`. */
export async function store(
  directory: string,
  name: string,
  data: Uint8Array,
): Promise<ReceiveResult> {
  if (readOnly) return { ok: false, reason: "read-only" };
  if (data.byteLength > COPY_MAX_BYTES) return { ok: false, reason: "too-large" };
  const target = await destination(directory, name);
  if (!target) return { ok: false, reason: "invalid" };
  try {
    await writeFile(target, data, { flag: "wx" });
  } catch (error: unknown) {
    if (errno(error) === "EEXIST") return { ok: false, reason: "exists" };
    throw error;
  }
  return { ok: true, mode: "copied", name };
}
