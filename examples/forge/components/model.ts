// Types shared by Server pages, Server Functions and Client Components. No runtime
// code: Client Components import them with `import type` only.
import type { Note, SaveResult } from "./draft";

export type Role = "maintainer" | "contributor" | "reader";
export type Identity = { id: string; name: string; role: Role };

export type PullState = "open" | "merged" | "closed";
export type Verdict = "approve" | "changes";
export type CheckStatus = "queued" | "running" | "success" | "failure";

export type Repo = { slug: string; description: string; openPulls: number };

export type PullSummary = {
  repo: string;
  number: number;
  title: string;
  author: string;
  state: PullState;
  revision: number;
  additions: number;
  deletions: number;
  comments: number;
  updatedAt: number;
};

export type PullDetail = PullSummary & {
  id: number;
  headBranch: string;
  baseBranch: string;
  mergedBy: string | null;
};

/** One rendered row of a unified patch, in the order the diff renderable draws it. */
export type DiffRow = { kind: "context" | "add" | "delete"; old?: number; new?: number };
export type Side = "old" | "new";

export type FileSummary = {
  path: string;
  language: string;
  additions: number;
  deletions: number;
};
export type FileDiff = FileSummary & { patch: string; rows: DiffRow[] };
/** One side of a file at a revision, whole: `old` before the change, `new` after it. */
export type FileSource = { path: string; revision: number; side: Side; content: string };

export type Comment = {
  id: number;
  author: string;
  body: string;
  path: string | null;
  side: Side | null;
  line: number | null;
  revision: number;
  createdAt: number;
};
export type Review = { reviewer: string; verdict: Verdict; revision: number; createdAt: number };

export type Check = {
  id: number;
  name: string;
  status: CheckStatus;
  attempt: number;
  durationMs: number;
};

export type MergeReadiness = {
  approvals: string[];
  changesRequested: string[];
  checks: CheckStatus[];
  canMerge: boolean;
  reasons: string[];
};

/** Result of an operation that is not a document save (review, merge, rerun). */
export type OperationResult =
  | { ok: true; operationId: string; message: string }
  | { ok: false; operationId: string; error: string };

/** A composer publishes its Draft and starts again empty; `number` names a new PR. */
export type PublishResult = SaveResult & { number?: number };

export type ComposerNote = Note;
export type LoginResult =
  | { ok: true; token: string; identity: Identity }
  | { ok: false; error: string };
