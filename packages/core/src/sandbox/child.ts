/**
 * The sandboxed side of the `sandbox` mode (src/sandbox/spawn.ts): started by the host
 * under Seatbelt, on the PTY its VT widget shows, with an IPC channel to it. A Client like
 * any other (`run()`): the application's bundle evaluated against this runtime, its
 * sessions under its origin, its `host` requests sent to the host process, which decides.
 *
 *   bun child.ts --url <server> --bundle <origin>/app --origin <origin>
 *                --sessions <openSession name> --publisher <fingerprint>
 *                --capabilities <{ capability: granted | denied | prompt }>
 */
import { parseArgs } from "node:util";
import { applicationOf, loadAppBundle } from "../app-bundle";
import { run } from "../client";
import { CapabilityStates } from "../host";
import { ipcChannel } from "./ipc";

const { values } = parseArgs({
  options: {
    url: { type: "string" },
    bundle: { type: "string" },
    origin: { type: "string" },
    sessions: { type: "string" },
    publisher: { type: "string" },
    capabilities: { type: "string" },
  },
  strict: true,
});
const { bundle, origin, sessions, publisher } = values;
if (!values.url || !bundle || !origin || !sessions || !publisher)
  throw new Error("Usage: child.ts --url --bundle --origin --sessions --publisher");
// The host checked it already; checked again here, where it is evaluated.
const loaded = await loadAppBundle(bundle, {
  publisher: {
    required: true,
    trust: (fingerprint) => {
      if (fingerprint !== publisher) throw new Error(`${origin}: not signed by the pinned key`);
    },
  },
});
// Where the mediated capabilities stand at start; the host reports each change.
const host = ipcChannel(CapabilityStates.parse(JSON.parse(values.capabilities ?? "{}")));
// The host is gone (even killed): leave as a closed terminal makes a Client leave, its
// session kept to be restored.
process.on("disconnect", () => process.kill(process.pid, "SIGHUP"));
await run((options) => applicationOf(loaded, { ...options, host }), {
  name: sessions,
  sessionKey: origin,
});
