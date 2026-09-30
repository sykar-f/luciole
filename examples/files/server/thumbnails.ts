import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { z } from "zod";
import type { Thumbnail } from "../components/model";

// Images never travel whole: the Client asks for the pixel size its pane can show, and
// gets a small WebP. libvips works on its own threads, so a 12 MP photo does not stall
// the Server's other requests; JPEGs are even decoded at a reduced scale directly.

// Requested sizes are rounded up to a grid, so that nearby pane sizes share one entry.
const GRID = 64,
  SMALLEST = 16,
  LARGEST = 2048,
  QUALITY = 80;
// Recent thumbnails stay in memory; all of them stay on disk, keyed by file identity.
const MEMORY_BYTES = 33_554_432; // 32 MiB

const CacheHome = z.string().min(1).optional();
const directory = join(
  CacheHome.parse(process.env.XDG_CACHE_HOME) ?? join(homedir(), ".cache"),
  "luciole-files",
  "thumbnails",
);

export type Target = { width: number; height: number };
const side = (n: number) => Math.min(LARGEST, Math.max(SMALLEST, Math.ceil(n / GRID) * GRID));

const memory = new Map<string, Thumbnail>();
let memoryBytes = 0;
// A prefetch and the request that follows it share the same work.
const running = new Map<string, Promise<Thumbnail>>();

function remember(key: string, thumbnail: Thumbnail) {
  memory.set(key, thumbnail);
  memoryBytes += thumbnail.data.byteLength;
  for (const [oldest, value] of memory) {
    if (memoryBytes <= MEMORY_BYTES) break;
    memory.delete(oldest);
    memoryBytes -= value.data.byteLength;
  }
}

const bytes = (buffer: Buffer) =>
  new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);

async function fromDisk(file: string): Promise<Thumbnail | null> {
  const data = await readFile(file).catch(() => null);
  if (!data) return null;
  const { width, height } = await sharp(data).metadata();
  return { data: bytes(data), width, height };
}

async function render(path: string, target: Target, file: string): Promise<Thumbnail> {
  const { data, info } = await sharp(path, { failOn: "none" })
    .rotate() // EXIF orientation, as a photo viewer shows it
    .resize({ ...target, fit: "inside", withoutEnlargement: true })
    .webp({ quality: QUALITY })
    .toBuffer({ resolveWithObject: true });
  // Written aside then renamed: a crash never leaves a truncated cache entry.
  const partial = `${file}.${process.pid}.partial`;
  await mkdir(directory, { recursive: true });
  await writeFile(partial, data)
    .then(() => rename(partial, file))
    .catch(() => {});
  return { data: bytes(data), width: info.width, height: info.height };
}

/** A WebP of the image at `path`, fitting `target`; cached by path, size, date and target. */
export function thumbnail(
  path: string,
  file: { size: number; modified: number },
  requested: Target,
): Promise<Thumbnail> {
  const target = { width: side(requested.width), height: side(requested.height) };
  const key = createHash("sha256")
    .update(`${path}\0${file.size}\0${file.modified}\0${target.width}x${target.height}`)
    .digest("hex");
  const hit = memory.get(key);
  if (hit) {
    memory.delete(key);
    memory.set(key, hit);
    return Promise.resolve(hit);
  }
  const pending = running.get(key);
  if (pending) return pending;
  const cached = join(directory, `${key}.webp`);
  const work = (async () => {
    const found = (await fromDisk(cached)) ?? (await render(path, target, cached));
    remember(key, found);
    return found;
  })().finally(() => running.delete(key));
  running.set(key, work);
  return work;
}

/** Dimensions as displayed (EXIF orientation applied), read from the header only. */
export async function dimensions(path: string) {
  const meta = await sharp(path, { failOn: "none" }).metadata();
  return meta.autoOrient ?? { width: meta.width, height: meta.height };
}
