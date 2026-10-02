import { NativeImage, type RenderContext } from "@opentui/core";
import type { Doc } from "../model/types.ts";

// Images, as a README shows them: the editor keeps `![alt](url)` as written (a verbatim
// span) and draws the picture in its place when the terminal draws pictures (the Kitty
// graphics protocol, or sixels), its alternative text otherwise.

/** How an image written in Markdown starts. */
export const IMAGE_MARK = "![";
/** An image's size in pixels. */
export type ImageSize = { readonly width: number; readonly height: number };
/** Link reference definitions, by label in lower case: what `![alt][label]` points at. */
export type Definitions = ReadonlyMap<string, string>;

const INLINE = /^!\[([^\]]*)\]\(\s*<?([^\s)>]+)>?(?:\s+(?:"[^"]*"|'[^']*'|\([^)]*\)))?\s*\)$/;
const REFERENCE = /^!\[([^\]]*)\](?:\[([^\]]*)\])?$/;
const DEFINITION = /^[ \t]*\[([^\]\n]+)\]:[ \t]*<?([^\s>]+)>?/gm;

/** The image `source` is written as, or null when it is not one. */
export function imageOf(source: string, definitions: Definitions) {
  if (!source.startsWith(IMAGE_MARK)) return null;
  const inline = INLINE.exec(source);
  if (inline) return { alt: inline[1] ?? "", url: inline[2] ?? "" };
  const reference = REFERENCE.exec(source);
  if (!reference) return null;
  const alt = reference[1] ?? "";
  const url = definitions.get((reference[2] || alt).trim().toLowerCase());
  return url ? { alt, url } : null;
}

/** The link reference definitions of a document: raw blocks, as the editor keeps them. */
export function definitionsOf(doc: Doc): Definitions {
  const found = new Map<string, string>();
  for (const block of doc) {
    if (block.type !== "raw" || !block.text.includes("]:")) continue;
    for (const match of block.text.matchAll(DEFINITION)) {
      const label = match[1]?.trim().toLowerCase();
      if (label && match[2] && !found.has(label)) found.set(label, match[2]);
    }
  }
  return found;
}

/** How a terminal draws pictures, or null when it does not. */
export type Protocol = "kitty" | "sixel";

/**
 * The protocol images are drawn with in `ctx`'s terminal, as OpenTUI's own image renderable
 * picks it (`auto`), but without its fallback in half-blocks: a blurred picture reads worse
 * than its alternative text.
 */
export function protocolOf(ctx: RenderContext): Protocol | null {
  const capabilities = ctx.capabilities;
  if (!capabilities || capabilities.multiplexer === "tmux") return null;
  if (capabilities.kitty_graphics) return "kitty";
  const resolution = ctx.resolution;
  if (capabilities.sixel && resolution && resolution.width > 0 && resolution.height > 0)
    return "sixel";
  return null;
}

type Entry =
  | { readonly state: "loading" }
  | { readonly state: "ready"; readonly image: NativeImage }
  | { readonly state: "missing" };

const MAX_IMAGES = 64;
// Shared by every editor: a note opened again draws its images at once.
const entries = new Map<string, Entry>();
const waiting = new Set<() => void>();

/**
 * The image at `url`, loaded once (in the background: `onReady` is called when it arrives
 * or fails), by `load` when it is not a file or an address (math drawn to a picture).
 * Undefined while it loads.
 */
export function imageAt(
  url: string,
  onReady: () => void,
  load: () => Promise<NativeImage> = () => NativeImage.load(url),
): NativeImage | "missing" | undefined {
  const entry = entries.get(url);
  if (entry?.state === "ready") return entry.image;
  if (entry?.state === "missing") return "missing";
  waiting.add(onReady);
  if (entry) return undefined;
  entries.set(url, { state: "loading" });
  load().then(
    (image) => settle(url, { state: "ready", image }),
    () => settle(url, { state: "missing" }),
  );
  return undefined;
}
/** Stops calling `onReady`: its editor is gone. */
export const forgetWaiting = (onReady: () => void) => waiting.delete(onReady);

function settle(url: string, entry: Entry) {
  entries.set(url, entry);
  if (entries.size > MAX_IMAGES) {
    const [oldest] = entries.keys();
    // The oldest is dropped from the cache, not disposed: an editor may be drawing it.
    if (oldest !== undefined && oldest !== url) entries.delete(oldest);
  }
  for (const ready of waiting) ready();
}
