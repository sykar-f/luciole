import type { HarnessId } from "../../components/model";
import { ClaudeHarness } from "./claude";
import { CodexHarness } from "./codex";
import { FakeHarness } from "./fake";
import { OpencodeHarness } from "./opencode";
import { PiHarness } from "./pi";
import type { Harness, HarnessContext } from "./types";

/** The adapter of a harness; each one is written against its own protocol report. */
export function createHarness(id: HarnessId, context: HarnessContext): Harness {
  switch (id) {
    case "fake":
      return new FakeHarness(context);
    case "claude":
      return new ClaudeHarness(context);
    case "codex":
      return new CodexHarness(context);
    case "pi":
      return new PiHarness(context);
    case "opencode":
      return new OpencodeHarness(context);
  }
}
