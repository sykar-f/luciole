/**
 * A desktop window can close before the launcher or Client has finished starting.
 * Keep one handler across their separately bundled modules, and register resources
 * as they are acquired. Once the Client is ready, its normal quit restores the TTY.
 */
type Cleanup = () => void | Promise<void>;
type DesktopHangup = {
  quitting: boolean;
  add(cleanup: Cleanup): void;
  handle(quit: () => void): void;
};
const shared: typeof globalThis & {
  __lucioleDesktopHangup?: DesktopHangup;
} = globalThis;

export function desktopHangup(): DesktopHangup | undefined {
  if (process.env["LUCIOLE_DESKTOP"] !== "1" || process.argv[2] === "serve") return undefined;
  if (shared.__lucioleDesktopHangup) return shared.__lucioleDesktopHangup;
  const cleanups: Cleanup[] = [];
  let quit: (() => void) | undefined;
  const state: DesktopHangup = {
    quitting: false,
    add: (cleanup) => void cleanups.push(cleanup),
    handle: (ready) => {
      quit = ready;
    },
  };
  shared.__lucioleDesktopHangup = state;
  process.on("SIGHUP", () => {
    if (state.quitting) return;
    state.quitting = true;
    if (quit) return quit();
    void (async () => {
      let code = 0;
      for (const cleanup of cleanups.reverse()) {
        try {
          await cleanup();
        } catch (error) {
          console.error(error);
          code = 1;
        }
      }
      process.exit(code);
    })();
  });
  return state;
}

// Install during module loading, before either entry point starts asynchronous work.
desktopHangup();
