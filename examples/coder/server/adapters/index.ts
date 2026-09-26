import "server-only";
import type { HarnessId } from "../../components/model";
import { FakeHarness } from "./fake";
import type { Harness, HarnessContext } from "./types";

/** The adapter of a harness; each one is written against its own protocol report. */
export function createHarness(id: HarnessId, context: HarnessContext): Harness {
  switch (id) {
    case "fake":
      return new FakeHarness(context);
    case "claude":
    case "codex":
    case "pi":
    case "opencode":
      throw new Error(`The ${id} adapter is not written yet`);
  }
}
