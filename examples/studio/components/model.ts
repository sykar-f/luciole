// What studio's Server tells its Client beside the harness's session (which follows
// @luciole/harness/model): the project, its revisions, where the last validation stands
// and what the preview shows. Plain data, read by both sides.

/** A validation's stages, in order: `types` runs beside the preview, `render` is reported by it. */
export const STAGES = ["guard", "build", "server", "render", "types"] as const;
export type Stage = (typeof STAGES)[number];
export const STAGE_LABELS: Record<Stage, string> = {
  guard: "Checks",
  build: "Build",
  server: "Server",
  render: "Render",
  types: "Types",
};

export type Diagnostic = { file?: string; line?: number; message: string };
export type StageResult = { stage: Stage; ok: boolean; ms?: number };

export type Validation = {
  state: "idle" | "validating" | "passed" | "failed";
  /** The revision being checked, or the one that failed. */
  revision?: number;
  stages: readonly StageResult[];
  failed?: Stage;
  diagnostics: readonly Diagnostic[];
  /** Automatic corrections spent on the current request, and allowed. */
  fixes: number;
  maxFixes: number;
};

export type RevisionInfo = {
  number: number;
  summary: string;
  at: number;
  /** What is known to be wrong with it, once it runs. */
  problem?: "types" | "render";
};

/** What the Client needs to show a revision or a draft (server/preview.ts, PreviewTarget). */
export type PreviewInfo = {
  /** Its build: a new one is a new program in the preview. */
  id: string;
  /** The revision shown, or for a draft the one it was written over. */
  revision: number;
  /** Built during a turn from what the harness wrote so far. */
  draft: boolean;
  url: string;
  output: string;
  fingerprint: string;
  mode: "sandbox" | "process";
  /** Network hosts the user allowed the app. */
  hosts: readonly string[];
  sessions: string;
  session: string;
  project: string;
};

/**
 * Where the drafts of the current turn stand: one `building`, or the last one did not
 * make it (refused, or its build or Server failed) and the preview shows the one before.
 */
export type DraftState = "building" | "waiting" | null;

export type StudioSnapshot = {
  project: { name: string; directory: string };
  preview: PreviewInfo | null;
  /** Why there is no preview (no sandbox here, a Server that did not start). */
  previewError: string | null;
  validation: Validation;
  draft: DraftState;
  /** Newest first. */
  revisions: readonly RevisionInfo[];
  /** A warning shown as long as it holds: the preview runs with the user's rights. */
  warning: string | null;
};
