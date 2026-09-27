import type { HarnessId } from "../model";
import { FakeHarness } from "./fake";
import type { Harness, HarnessContext } from "./types";

/**
 * The adapters of the in-browser Server (`airtty build --web-local`, docs/WEB.md): only
 * the scripted one. The others start processes, and the Claude Agent SDK imports
 * `readline` and `net`, which a browser bundle cannot hold (package.json, `imports`).
 */
export function createHarness(id: HarnessId, context: HarnessContext): Harness {
  if (id === "fake") return new FakeHarness(context);
  throw new Error(`Only the scripted harness runs in a browser, not ${id}`);
}
