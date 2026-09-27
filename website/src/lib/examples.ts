// The example applications as the site shows them: the landing's gallery picks the ones
// that run in a page, /examples shows them all. `demo` is the directory scripts/demo.ts
// builds under public/demo/; without one, the app needs a real terminal and the page
// shows its capture (scripts/capture.py).
import type { Step } from "../components/LiveTerminal.astro";

export interface Example {
  name: string;
  /** Where its code is, from the root of the repository. */
  source: string;
  /** Its captured screen, in src/frames/. */
  frame: string;
  demo?: string;
  /** Keys played once the demo has drawn, to reach the capture's screen. */
  script?: Step[];
  run: string;
  /** What it demonstrates, in two lines at most. */
  about: string;
  /** Why it does not run in a page. */
  terminal?: string;
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
    type: "How does airtty keep typing local when the Server is 500 ms away?\r",
  },
  { wait: "Done.", type: "" },
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
    run: "bun run forge",
    about:
      "Code review in a terminal: pull requests, coloured diffs, line comments, live CI logs and merge. It puts every part of the framework to work at once.",
  },
  notes: {
    name: "Notes",
    source: "examples/notes",
    frame: "notes",
    demo: "notes",
    run: "bun run dev",
    about:
      "The reference app: a server page reads SQLite, the editor keeps what you type while a save travels, and a save whose answer was lost is looked up, never replayed.",
  },
  chat: {
    name: "Chat",
    source: "examples/chat",
    frame: "chat",
    demo: "chat",
    script: ask,
    run: "OPENROUTER_API_KEY=… bun run chat",
    about:
      "Answers stream token by token from a Server Function; the key never leaves the server. Here a scripted model answers, since no key can live in a page.",
  },
  mdreader: {
    name: "mdreader",
    source: "examples/mdreader",
    frame: "mdreader",
    demo: "mdreader",
    run: "MD_PATH=docs bun run mdreader",
    about:
      "A folder of Markdown in two panes, with tables, code and outlines: here, this repository's docs. On disk, it reloads when a file changes and keeps your place.",
  },
  devtools: {
    name: "DevTools",
    source: "packages/airtty/src/devtools/airtty-devtools",
    frame: "devtools-network",
    demo: "devtools",
    run: "bun packages/airtty/src/cli.ts devtools --demo",
    about:
      "Both processes in one waterfall, with the cache that answered, component trees and logs, on a recorded session. The DevTools are an airtty app too.",
  },
  coder: {
    name: "coder",
    source: "examples/coder",
    frame: "coder",
    run: "bun run coder -- --harness fake",
    about:
      "One coding-agent session on Claude Code, Codex, pi or opencode, driving the binaries you installed. The session lives on the server: the client can crash, the agent carries on.",
    terminal:
      "Its server drives agent binaries. Captured here on its scripted harness, which needs no model.",
  },
  files: {
    name: "Files",
    source: "examples/files",
    frame: "files",
    run: "bun run files",
    about: "A file explorer with previews, images included.",
    terminal: "Previews images through a native library, and browses your disk.",
  },
  mux: {
    name: "mux",
    source: "examples/mux",
    frame: "mux",
    run: "bun run mux",
    about: "A small tmux: your shell and vim side by side, with another airtty app in a pane.",
    terminal: "Runs your shell and vim on real PTYs.",
  },
};
