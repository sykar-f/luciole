import type { Request, Response } from "@luciole/harness/model";
import { writable } from "./guard";

/**
 * How studio answers the harness's requests itself (examples/studio/DESIGN.md, 5.5, layer 1):
 * no command runs, a file change inside the app's folders is accepted, one outside is
 * refused before it happens. Questions and plans stay the user's.
 */
export function policy(request: Request): Response | undefined {
  if (request.kind !== "approval") return undefined;
  const deny: Response = { kind: "approval", decision: "deny" };
  if (request.command) return deny;
  const files = request.files ?? [];
  if (files.length && files.every((file) => writable(file.path)))
    return { kind: "approval", decision: "once" };
  return deny;
}
