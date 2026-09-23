"use server";
import { z } from "zod";
import type { ImageTarget, Preview, Thumbnail } from "../components/model";
import { preview as read, resized } from "../server/fs";

const PATH_MAX = 4096,
  SIDE_MAX = 8192;
const PathSchema = z.string().max(PATH_MAX);
const TargetSchema = z.object({
  width: z.number().int().positive().max(SIDE_MAX),
  height: z.number().int().positive().max(SIDE_MAX),
});
const ErrnoSchema = z.object({ code: z.string() });

/**
 * The preview of one entry, read when the Client selects it. An image comes as a
 * thumbnail fitting `target`, the pixel size of the Client's pane.
 */
export async function preview(path: string, target?: ImageTarget): Promise<Preview> {
  const relative = PathSchema.parse(path);
  const size = TargetSchema.optional().parse(target);
  try {
    return await read(relative, size);
  } catch (error: unknown) {
    // Permission denied, removed meanwhile…: an answer for the pane, not a failed request.
    const errno = ErrnoSchema.safeParse(error);
    return { kind: "unavailable", reason: errno.success ? errno.data.code : "Unreadable" };
  }
}

/** The same image for another pane size; `null` when the path is not an image any more. */
export async function thumbnail(path: string, target: ImageTarget): Promise<Thumbnail | null> {
  return resized(PathSchema.parse(path), TargetSchema.parse(target)).catch(() => null);
}
