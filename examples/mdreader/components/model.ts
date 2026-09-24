// Plain data exchanged between the Server and the Client (no runtime, no native object).

/** A Markdown file of the library, `path` relative to its root with `/` separators. */
export type DocEntry = { path: string; size: number };

export type Library = {
  /** Directory the paths are relative to, as shown to the reader. */
  root: string;
  /** `MD_PATH` names one file: the library holds only that document. */
  single: boolean;
  docs: DocEntry[];
  /** The scan stopped at its limit: some documents are not listed. */
  truncated: boolean;
  /** Document shown at `/`: README.md, index.md, or the first one. */
  home: string | null;
  /** Why nothing can be listed (missing path, not Markdown…). */
  problem: string | null;
};

export type Doc = {
  path: string;
  /** Markdown as rendered: the file with its soft line breaks joined (server/reflow.ts). */
  content: string;
  /** Lines of the file on disk. */
  lines: number;
  size: number;
  modified: number;
  /** Only the first `MAX_BYTES` were read. */
  truncated: boolean;
};
