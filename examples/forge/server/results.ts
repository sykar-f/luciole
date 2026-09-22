import type { OperationResult, PublishResult } from "../components/model";

// The ledger stores JSON; these guards restore the result type of each operation kind.
const record = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object";

export function isSaveResult(value: unknown): value is PublishResult {
  if (!record(value) || typeof value.operationId !== "string") return false;
  if (value.ok === false) return typeof value.error === "string";
  return value.ok === true && record(value.note) && typeof value.note.id === "string";
}
export function isOperationResult(value: unknown): value is OperationResult {
  if (!record(value) || typeof value.operationId !== "string") return false;
  if (value.ok === false) return typeof value.error === "string";
  return value.ok === true && typeof value.message === "string";
}
