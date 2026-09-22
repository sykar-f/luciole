"use server";
import type { SaveResult, Snapshot } from "@terminal/framework/client";
import type { OperationResult, PublishResult, Verdict } from "../components/model";
import { actor, forge } from "../server/instance";
import { isOperationResult, isSaveResult } from "../server/results";

type Target = { repo: string; number: number; revision: number; operationId: string };

// The operator script can arm a lost response: the business change is committed, then
// the response fails. The Client sees an unknown outcome and must resolve, not replay.
function deliver<T extends { ok: boolean }>(kind: "merge" | "review" | "publish", result: T): T {
  if (result.ok && forge.consumeFault(kind)) throw new Error(`Injected lost ${kind} response`);
  return result;
}

export async function saveDescription(snapshot: Snapshot): Promise<SaveResult> {
  return forge.saveDescription(actor(), snapshot);
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
  return forge.rerun(actor(), target);
}
// Resolve an unknown outcome from the ledger. They never replay the operation; `null`
// means nothing was committed under this identifier yet.
export async function resolveSave(operationId: string): Promise<PublishResult | null> {
  const result = forge.operation(actor(), operationId);
  return isSaveResult(result) ? result : null;
}
export async function resolveOperation(operationId: string): Promise<OperationResult | null> {
  const result = forge.operation(actor(), operationId);
  return isOperationResult(result) ? result : null;
}
