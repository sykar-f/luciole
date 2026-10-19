/** UI substitutes for the isolated runInPage output test; NativeSession is real WASM. */
import { NativeSession } from "@opentui/core";
import type { Application } from "../packages/core/src/client";
import type { terminalOutput } from "../packages/core/src/web/streams";

interface PatchedSession extends NativeSession {
  beginFrameOutput(): Promise<void>;
  endFrameOutput(commit: boolean): Promise<void>;
  writeControl(bytes: Uint8Array): Promise<void>;
}
function patched(session: NativeSession): session is PatchedSession {
  return ["beginFrameOutput", "endFrameOutput", "writeControl"].every(
    (key) => typeof Reflect.get(session, key) === "function",
  );
}

const chunks: string[] = [];
const initialSession: PatchedSession | undefined = undefined;
export const state: {
  chunks: string[];
  write: (this: void, commands: string) => void;
  session: PatchedSession | undefined;
  missing: boolean;
  reject: boolean;
  hold: boolean;
  resume: () => void;
  reached: () => void;
} = {
  chunks,
  write: (_commands: string) => {},
  session: initialSession,
  missing: false,
  reject: false,
  hold: false,
  resume: () => {},
  reached: () => {},
};
export class Terminal {
  cols = 40;
  rows = 10;
  loadAddon() {}
  open() {}
  focus() {}
  onData() {}
  onResize() {}
  onWriteParsed() {}
  onRender() {}
  write(chunk: string | Uint8Array, done?: () => void) {
    state.chunks.push(typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk));
    if (state.hold && done) {
      state.hold = false;
      state.resume = done;
      state.reached();
    } else done?.();
  }
}
export class FitAddon {
  fit() {}
}
export const attachTerminalView = () => ({});
export const wheelReports = () => () => false;
export const cellAt = () => undefined;
export const wheelRoom = () => ({ up: false, down: false });
export const embedded = false;
export const controlledNetwork = () => undefined;
export const onInput = () => {};
export const tellTyped = () => {};
export const exposeCells = () => {};
export const exposeRenderer = () => {};
export const exposeScreen = () => {};
export const exposeScrollRoom = () => {};
export const exposeWrites = () => {};
export const stage = () => {};
export const tellEvent = () => {};
export const Shell = () => null;
export const createRoot = () => ({ render() {} });
// eslint-disable-next-line typescript/consistent-type-assertions -- Only the page lifecycle is exercised; no application shell is mounted.
export const createApp = () =>
  ({ onEvent() {}, restoration: { persistTo() {} } }) as unknown as Application;
export function attachPixelScroll(_renderer: unknown, options: { write(commands: string): void }) {
  state.write = options.write;
  return { ordinary() {} };
}
export function createCliRenderer(options: { stdout: ReturnType<typeof terminalOutput> }) {
  const session = new NativeSession(options.stdout, {
    output: { chunkSize: 256, spanCapacity: 32, maxBytes: 8192n, controlCapacity: 128 },
    outputBufferSize: 17,
  });
  if (!patched(session)) throw new Error("Missing patched Wasm session methods");
  state.session = session;
  return {
    closed: Promise.resolve(),
    ...(state.missing
      ? {}
      : {
          writeControl(bytes: Uint8Array) {
            return state.reject
              ? Promise.reject(new Error("page control write rejected"))
              : session.writeControl(bytes);
          },
        }),
  };
}
