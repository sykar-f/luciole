/**
 * `node:console` in a page: OpenTUI builds a `Console` to capture what the app logs; its
 * streams do not exist here, so it forwards to the page's console.
 */
export class Console {
  log = (...args: unknown[]) => globalThis.console.log(...args);
  info = (...args: unknown[]) => globalThis.console.info(...args);
  warn = (...args: unknown[]) => globalThis.console.warn(...args);
  error = (...args: unknown[]) => globalThis.console.error(...args);
  debug = (...args: unknown[]) => globalThis.console.debug(...args);
  trace = (...args: unknown[]) => globalThis.console.trace(...args);
}
export default { Console };
