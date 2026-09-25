/**
 * `node:module`, `node:worker_threads`, `node:child_process`, `node:tty` in a page: what
 * OpenTUI imports from them serves native loading, tree-sitter workers and local
 * terminals, none of which the browser runtime has. Loading works; using says why not.
 */
const unavailable = (name: string) => () => {
  throw new Error(`${name} is not available in the browser runtime`);
};
export const createRequire = () => unavailable("require");
export const isMainThread = true;
export const parentPort = null;
export const workerData = null;
export class Worker {
  constructor() {
    unavailable("Worker threads")();
  }
}
export const spawn = unavailable("child_process");
export const spawnSync = unavailable("child_process");
export const isatty = () => false;
export class ReadStream {}
export class WriteStream {}
export default {
  createRequire,
  isMainThread,
  parentPort,
  workerData,
  Worker,
  spawn,
  spawnSync,
  isatty,
};
