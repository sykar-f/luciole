"use server";
import { invalidate } from "@luciole-sh/core/server";
import { z } from "zod";
import type { Fingerprint, ReceiveResult } from "../components/model";
import { receive as move, store } from "../server/receive";

const PATH_MAX = 4096,
  NAME_MAX = 255;
const Directory = z.string().max(PATH_MAX);
const Name = z.string().min(1).max(NAME_MAX);
const FingerprintSchema = z.object({
  path: z.string().max(PATH_MAX),
  dev: z.number(),
  ino: z.number(),
  size: z.number(),
  modified: z.number(),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
});

// A new file changes the listing on screen: the Client revalidates its route.
function changed(result: ReceiveResult) {
  if (result.ok) invalidate();
  return result;
}

/** Moves a dropped file into `directory` if the Server shares the terminal's machine. */
export async function receiveDropped(
  directory: string,
  name: string,
  source: Fingerprint,
): Promise<ReceiveResult> {
  return changed(
    await move(Directory.parse(directory), Name.parse(name), FingerprintSchema.parse(source)),
  );
}

/** Stores a copy of a dropped file sent by a Client on another machine. */
export async function uploadDropped(
  directory: string,
  name: string,
  data: Uint8Array,
): Promise<ReceiveResult> {
  return changed(
    await store(Directory.parse(directory), Name.parse(name), z.instanceof(Uint8Array).parse(data)),
  );
}
