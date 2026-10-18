import type { ProgramStatus } from "@luciole-sh/core/client";
import type { Snapshot } from "../model";

// Protocol text is a single line with at most 2048 UTF-8 bytes. 500 code points fit
// even when every one needs four bytes. Harness text can contain newlines or escapes.
const MAX_STATUS_CHARACTERS = 500;
const line = (text: string) =>
  // Control characters are forbidden by OSC 7501, even inside base64 text.
  // eslint-disable-next-line no-control-regex
  Array.from(text.replace(/[\x00-\x1f\x7f-\x9f]/g, " "))
    .slice(0, MAX_STATUS_CHARACTERS)
    .join("");

/** Permission wins over running: the turn is live, but cannot proceed without the user. */
export function sessionProgramStatus(snap: Snapshot): ProgramStatus {
  const request = snap.requests[0];
  if (request)
    return {
      state: "blocked",
      kind: request.kind === "approval" ? "permission" : "question",
      message: line(
        request.kind === "approval"
          ? request.title
          : request.kind === "question"
            ? (request.questions[0]?.question ?? "Answer the agent")
            : "Review the plan",
      ),
    };
  if (snap.error) return { state: "error", message: line(snap.error) };
  if (snap.state === "stopped") return { state: "error", message: "Harness stopped" };
  if (snap.state !== "idle") return { state: "working" };
  return { state: snap.items.length ? "done" : "idle" };
}
