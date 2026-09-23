// Plain data exchanged between the Server and the Client: no functions, no classes.

export type EntryKind = "directory" | "file" | "symlink" | "other";

/** One row of a directory listing, as `lstat` saw it (a symlink also carries its target). */
export type Entry = {
  name: string;
  /** Relative to the explorer root, `/`-separated; `""` is the root itself. */
  path: string;
  kind: EntryKind;
  size: number;
  modified: number;
  mode: number;
  target?: string;
  /** What a symlink points to; `undefined` when the link is broken. */
  targetKind?: EntryKind;
};

export type Listing = {
  /** Absolute root, for the header only: every path the Client sends is relative. */
  root: string;
  path: string;
  entries: Entry[];
  /** More entries than the Server sends in one listing. */
  truncated: boolean;
};

export type ImageFormat = "png" | "jpeg" | "gif" | "webp";

/** A reduced WebP of an image, computed and cached by the Server. */
export type Thumbnail = { data: Uint8Array; width: number; height: number };
/** The pixel size the Client's image pane can show. */
export type ImageTarget = { width: number; height: number };

export type Preview =
  | {
      kind: "text";
      language: string;
      content: string;
      lines: number;
      /** Only the head of the file is sent. */
      truncated: boolean;
    }
  | {
      kind: "image";
      format: ImageFormat;
      /** The image as displayed; the thumbnail is a reduced copy fitting the pane. */
      width: number;
      height: number;
      thumbnail: Thumbnail;
    }
  | { kind: "directory"; entries: { name: string; kind: EntryKind }[]; total: number }
  | { kind: "binary"; hex: string[] }
  | { kind: "empty" }
  | { kind: "unavailable"; reason: string };

// Client and Server compare the head of a dropped file to prove they see the same one.
export const FINGERPRINT_BYTES = 1_048_576; // 1 MiB

/** A file dropped on the terminal, as the Client's machine sees it. */
export type Fingerprint = {
  /** Absolute path on the Client's machine. */
  path: string;
  dev: number;
  ino: number;
  size: number;
  modified: number;
  /** SHA-256 of the first MiB. */
  sha256: string;
};

// A copy to a remote Server travels whole in one request.
export const COPY_MAX_BYTES = 33_554_432; // 32 MiB

export type ReceiveResult =
  | { ok: true; mode: "moved" | "copied"; name: string }
  | { ok: false; reason: "exists" | "not-local" | "read-only" | "invalid" | "too-large" };
