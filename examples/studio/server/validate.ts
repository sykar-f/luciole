/**
 * The first stages of a validation (docs/studio/SPEC.md, 5.4), shared by the studio and
 * its tests: the guard on the changes of a turn (refused changes are undone), then a
 * build of the working tree apart from the one the preview runs.
 */
import type { Diagnostic, Stage } from "../components/model";
import { guard } from "./guard";
import type { PreviewServers } from "./preview";
import type { Project } from "./project";

export type Prepared =
  | { ok: true; output: string }
  | { ok: false; stage: Stage; diagnostics: Diagnostic[]; undone: boolean };

export async function prepare(
  project: Project,
  servers: PreviewServers,
  changes: ReadonlyMap<string, string | null>,
  onStage: (stage: Stage, ok: boolean, ms: number) => void = () => {},
): Promise<Prepared> {
  let started = performance.now();
  const refused = guard(changes);
  onStage("guard", !refused.length, performance.now() - started);
  if (refused.length) {
    project.discard([...new Set(refused.map((r) => r.file))]);
    return {
      ok: false,
      stage: "guard",
      diagnostics: refused.map(({ file, reason }) => ({ file, message: reason })),
      undone: true,
    };
  }
  started = performance.now();
  const built = await servers.build(`b${Date.now()}`);
  onStage("build", "output" in built, performance.now() - started);
  if (!("output" in built))
    return { ok: false, stage: "build", diagnostics: built.diagnostics, undone: false };
  return { ok: true, output: built.output };
}
