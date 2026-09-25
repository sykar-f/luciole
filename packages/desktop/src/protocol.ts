/**
 * The messages between the host (Bun, the PTY) and the terminal view (xterm.js). Text
 * only: the host decodes the program's UTF-8, and the view sends what xterm.js encodes.
 */
import type { RPCSchema } from "electrobun/rpc";
import type { Size } from "./host/session";

export type TerminalRPC = {
  /** What the host receives. */
  bun: RPCSchema<{
    messages: {
      /** The view is laid out: the program starts at this size. */
      open: Size;
      /**
       * Keys, pastes, mouse reports and answers to the program's queries. `binary`: one
       * byte per character (legacy mouse reports), not text to encode as UTF-8.
       */
      input: { data: string; binary?: boolean };
      resize: Size;
    };
  }>;
  /** What the view receives. */
  webview: RPCSchema<{
    messages: {
      output: { data: string };
    };
  }>;
};
