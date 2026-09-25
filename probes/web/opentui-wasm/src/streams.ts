/**
 * The streams a renderer gets when it does not own a TTY (a browser terminal, a probe).
 * OpenTUI reads `stdin` as any Readable and duck-types the TTY capabilities of both
 * (renderer.ts, CliRendererConfig): these guards state that contract instead of casting.
 */
import { Readable, Writable } from "node:stream";

export const isInputStream = (stream: unknown): stream is NodeJS.ReadStream =>
  stream instanceof Readable;
export const isOutputStream = (stream: unknown): stream is NodeJS.WriteStream =>
  stream instanceof Writable;

/** A Writable that hands every frame to `write`, sized like a terminal of this size. */
export function terminalOutput(
  size: { columns: number; rows: number },
  write: (chunk: Uint8Array, done: () => void) => void,
) {
  const stream = Object.assign(
    new Writable({
      write(chunk: Uint8Array, _encoding, done) {
        write(chunk, done);
      },
    }),
    { ...size, isTTY: true },
  );
  if (!isOutputStream(stream)) throw new Error("unreachable: a Writable is an output stream");
  return stream;
}
