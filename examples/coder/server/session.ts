import { createHarness } from "@luciole-sh/harness/adapters";
import { HarnessSession } from "@luciole-sh/harness/session";
import { config } from "./config";
import { rememberLaunch, rememberedSession } from "./launches";

/**
 * The one agent session of this Server (one Server per launch), on the harness the
 * command line asked for. An explicit --resume wins; otherwise this launch's own
 * session, after a restart of its Server (a rebuild in development), continues.
 */
export const session = new HarnessSession({
  harness: config.harness,
  cwd: config.cwd,
  mode: config.mode,
  model: config.model,
  effort: config.effort,
  resume: config.resume,
  create: createHarness,
  remembered: (harness) => rememberedSession(config.launch, harness),
  remember: (harness, id) => void rememberLaunch(config.launch, harness, id),
});
