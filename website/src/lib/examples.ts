// The example applications as the site shows them: the landing's gallery picks the ones
// that run in a page, /examples shows them all. `demo` is the directory scripts/demo.ts
// builds under public/demo/; without one, the app needs a real terminal and the page
// shows its capture (scripts/capture.py).
import type { Step } from "../components/LiveTerminal.astro";
import { runCommands, type RunCommands } from "./example-commands";
import fakeHarness from "../../../packages/harness/src/adapters/fake.ts?raw";

export interface Example extends RunCommands {
  name: string;
  /** Where its code is, from the root of the repository. */
  source: string;
  /** Its captured screen, in src/frames/. */
  frame: string;
  demo?: string;
  /** Keys played once the demo has drawn, to reach the capture's screen. */
  script?: Step[];
  /** What it demonstrates, in two lines at most. */
  about: string;
  /** Why it does not run in a page. */
  terminal?: string;
  /** Said next to its live badge: what runs in the page instead of the real thing. */
  scripted?: string;
}

// Forge signs in as alice and opens a diff: the capture's screen.
const toDiff: Step[] = [
  { wait: "Demo accounts", type: "alice\r", pause: 250 },
  { wait: "Demo accounts", type: "forge\r" },
  { wait: "REVIEW REQUESTED", type: "j", pause: 250 },
  { wait: "REVIEW REQUESTED", type: "\r" },
  { wait: "wants to merge feature/refund-idempotency", type: "\t", pause: 400 },
  { wait: "files 0/4 viewed", type: "]", pause: 300 },
  { wait: "src/ledger.ts · typescript", type: "]" },
  { wait: "src/refunds.ts · typescript", type: "" },
];

// Chat is asked the capture's question, and replaces it once the answer has streamed.
const ask: Step[] = [
  {
    wait: "Ask anything",
    type: "How does luciole keep typing local when the Server is 500 ms away?\r",
  },
  { wait: "Done.", type: "" },
];

// coder is given the prompt its scripted harness answers, approves the edit, and replaces
// the capture on the harness's last words. Both are read from the harness itself: if they
// move, the build fails rather than the demo waiting for a screen that never comes.
function harnessString(name: string): string {
  const value = new RegExp(`export const ${name} =\\s*(["'])(.+?)\\1`).exec(fakeHarness)?.[2];
  if (!value) throw new Error(`packages/harness/src/adapters/fake.ts: ${name} not found`);
  return value;
}
// The harness streams its answer: about 12 s from the click to its last words on a fast
// machine. Each wait gets far more than the default 8 s, so a slow one still types `y`.
const AGENT_TIMEOUT_MS = 45_000;
// The composer shows before the session has started, and drops what is typed then: the
// prompt waits for the empty session's "<harness> is ready in <cwd>." (SessionScreen.tsx).
const session: Step[] = [
  { wait: "is ready in", type: `${harnessString("DEMO_PROMPT")}\r`, pause: 250 },
  { wait: "allow once", type: "y", timeout: AGENT_TIMEOUT_MS },
  { wait: harnessString("DEMO_END"), type: "", timeout: AGENT_TIMEOUT_MS },
];

export type ExampleKey =
  | "forge"
  | "notes"
  | "chat"
  | "mdreader"
  | "devtools"
  | "coder"
  | "files"
  | "mux";

export const examples: Record<ExampleKey, Example> = {
  forge: {
    name: "Forge",
    source: "examples/forge",
    frame: "forge-files",
    demo: "forge",
    script: toDiff,
    ...runCommands.forge,
    about:
      "Code review in a terminal: pull requests, coloured diffs, line comments, live CI logs and merge. It puts every part of the framework to work at once.",
  },
  notes: {
    name: "Notes",
    source: "examples/notes",
    frame: "notes",
    demo: "notes",
    ...runCommands.notes,
    about:
      "The reference app: a page reads SQLite on the Server. The editor keeps what you type while a save travels. A save whose answer was lost is looked up, then sent again under the same ID.",
  },
  chat: {
    name: "Chat",
    source: "examples/chat",
    frame: "chat",
    demo: "chat",
    script: ask,
    ...runCommands.chat,
    about:
      "Answers stream token by token from a Server Function; the key never leaves the Server. Here a scripted model answers, since no key can live in a page.",
  },
  mdreader: {
    name: "mdreader",
    source: "examples/mdreader",
    frame: "mdreader",
    demo: "mdreader",
    ...runCommands.mdreader,
    about:
      "A folder of Markdown in two panes, with tables, code and outlines: here, the documentation of this site. On disk, it reloads when a file changes and keeps your place.",
  },
  devtools: {
    name: "DevTools",
    source: "packages/core/src/devtools/luciole-devtools",
    frame: "devtools-network",
    demo: "devtools",
    ...runCommands.devtools,
    about:
      "Both processes in one waterfall, with the cache that answered, component trees and logs, on a recorded session. The DevTools are a luciole app too.",
  },
  coder: {
    name: "coder",
    source: "examples/coder",
    frame: "coder",
    demo: "coder",
    script: session,
    scripted: "Scripted demo · no model calls",
    ...runCommands.coder,
    about:
      "One coding-agent session on Claude Code, Codex, pi or opencode, driving the binaries you installed. The coding-agent session lives on the Server: the Client can crash, the agent carries on.",
  },
  files: {
    name: "Files",
    source: "examples/files",
    frame: "files",
    ...runCommands.files,
    about: "A file explorer with previews, images included.",
    terminal: "Previews images through a native library, and browses your disk.",
  },
  mux: {
    name: "mux",
    source: "examples/mux",
    frame: "mux",
    ...runCommands.mux,
    about: "A small tmux: your shell and vim side by side, with another luciole app in a pane.",
    terminal: "Runs your shell and vim on real PTYs.",
  },
};
