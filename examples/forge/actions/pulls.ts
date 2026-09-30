"use server";
import type { SaveResult, Snapshot } from "../components/draft";
import type {
  FileSource,
  OperationResult,
  PublishResult,
  Side,
  Verdict,
} from "../components/model";
import { invalidate } from "luciole/server";
import { actor, forge } from "../server/instance";
import { OperationResultSchema, PublishResultSchema } from "../server/results";

type Target = { repo: string; number: number; revision: number; operationId: string };

// The operator script can arm a lost response: the business change is committed, then
// the response fails. The Client sees an unknown outcome and must resolve, not replay.
function deliver<T extends { ok: boolean }>(kind: "merge" | "review" | "publish", result: T): T {
  if (result.ok && forge.consumeFault(kind)) throw new Error(`Injected lost ${kind} response`);
  return changed(result);
}
// A confirmed change refreshes every screen showing Forge data, the chrome included.
function changed<T extends { ok: boolean } | null>(result: T): T {
  if (result?.ok) invalidate();
  return result;
}

export async function saveDescription(snapshot: Snapshot): Promise<SaveResult> {
  return changed(forge.saveDescription(actor(), snapshot));
}
export async function publish(snapshot: Snapshot): Promise<PublishResult> {
  return deliver("publish", forge.publish(actor(), snapshot));
}
export async function openPullRequest(
  snapshot: Snapshot,
  title: string,
  branch: string,
): Promise<PublishResult> {
  return deliver("publish", forge.publish(actor(), snapshot, { title, branch }));
}
export async function review(target: Target & { verdict: Verdict }): Promise<OperationResult> {
  return deliver("review", forge.review(actor(), target));
}
export async function merge(target: Target): Promise<OperationResult> {
  return deliver("merge", forge.merge(actor(), target));
}
export async function rerunChecks(target: Omit<Target, "revision">): Promise<OperationResult> {
  return changed(forge.rerun(actor(), target));
}
/** A read: the file under review, whole, for the reviewer's own editor. Nothing changes. */
export async function fileSource(file: {
  repo: string;
  number: number;
  revision: number;
  path: string;
  side: Side;
}): Promise<FileSource | null> {
  actor();
  return forge.fileSource(file);
}
/**
 * A check's log, line by line as the clock reaches it. Opened by the Checks tab while it
 * is mounted (`useLive`), closed when the reviewer leaves it.
 */
export async function* checkLog(checkId: number): AsyncGenerator<string> {
  actor();
  yield* forge.checkLog(checkId);
}
// Resolve an unknown outcome from the ledger. They never replay the operation; `null`
// means nothing was committed under this identifier yet.
export async function resolveSave(operationId: string): Promise<PublishResult | null> {
  const result = PublishResultSchema.safeParse(forge.operation(actor(), operationId));
  return changed(result.success ? result.data : null);
}
export async function resolveOperation(operationId: string): Promise<OperationResult | null> {
  const result = OperationResultSchema.safeParse(forge.operation(actor(), operationId));
  return changed(result.success ? result.data : null);
}
