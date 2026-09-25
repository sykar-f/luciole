/**
 * `AsyncLocalStorage` where the engine has no async context (a browser Worker running the
 * Server, docs/WEB.md W6 and R2). A frame is current while code runs; what continues later
 * takes the frame it was scheduled in:
 *
 * - `await` and `yield`: transform.ts rewrites each into `__ac.resume(__ac.save(), await x)`
 *   (arguments evaluate left to right: the frame is saved before the wait, restored after);
 * - `then`, `setTimeout`, `setInterval`, `queueMicrotask`: patched by `install`, the
 *   callback runs in the frame of the call that scheduled it, then the previous one returns.
 *
 * Code that is neither transformed nor scheduled through these (a native stream pulling)
 * runs in whatever frame was current: stores are for the code the build transformed.
 */

/** A frame is an identity with a parent; each storage keeps its own values per frame. */
type Frame = { readonly parent: Frame | undefined };
let current: Frame = { parent: undefined };

function within<R>(frame: Frame, run: () => R): R {
  const previous = current;
  current = frame;
  try {
    return run();
  } finally {
    current = previous;
  }
}

/** What transformed code calls around every `await` and `yield`. */
export const hooks = {
  save: (): Frame => current,
  resume<T>(frame: Frame, value: T): T {
    current = frame;
    return value;
  },
};
// Defined as this module evaluates: a transformed module's top-level await may run before
// anything calls `install`.
if (!("__ac" in globalThis)) Object.defineProperty(globalThis, "__ac", { value: hooks });

export class AsyncLocalStorage<T> {
  /** A frame this storage set: its store, or `null` once exited there. */
  readonly #values = new WeakMap<Frame, { store: T } | null>();

  getStore(): T | undefined {
    for (let frame: Frame | undefined = current; frame; frame = frame.parent) {
      const value = this.#values.get(frame);
      if (value !== undefined) return value?.store;
    }
    return undefined;
  }
  #child(value: { store: T } | null): Frame {
    const frame = { parent: current };
    this.#values.set(frame, value);
    return frame;
  }
  run<R, A extends unknown[]>(store: T, callback: (...args: A) => R, ...args: A): R {
    return within(this.#child({ store }), () => callback(...args));
  }
  exit<R, A extends unknown[]>(callback: (...args: A) => R, ...args: A): R {
    return within(this.#child(null), () => callback(...args));
  }
  enterWith(store: T) {
    current = this.#child({ store });
  }
  disable() {
    current = this.#child(null);
  }
  static bind<A extends unknown[], R>(callback: (...args: A) => R): (...args: A) => R {
    const frame = current;
    return (...args) => within(frame, () => callback(...args));
  }
  static snapshot() {
    const frame = current;
    return <R, A extends unknown[]>(callback: (...args: A) => R, ...args: A) =>
      within(frame, () => callback(...args));
  }
}

/** `callback`, bound to the frame current now; anything else unchanged. */
function inFrame(callback: unknown): unknown {
  if (typeof callback !== "function") return callback;
  const frame = current;
  return (...args: unknown[]): unknown =>
    within(frame, (): unknown => Reflect.apply(callback, undefined, args));
}

function wrapFirstArguments(
  target: Promise<unknown> | typeof globalThis,
  name: string,
  count: number,
) {
  const original: unknown = Reflect.get(target, name);
  if (typeof original !== "function") throw new Error(`${name} is not a function`);
  const patched = Reflect.defineProperty(target, name, {
    configurable: true,
    writable: true,
    value(this: unknown, ...args: unknown[]): unknown {
      const bound = args.map((arg, i) => (i < count ? inFrame(arg) : arg));
      return Reflect.apply(original, this, bound);
    },
  });
  if (!patched) throw new Error(`${name} cannot be patched`);
}

const PROMISE_CONTINUATIONS = "then";
let installed = false;
/** Patches the schedulers: their callbacks run in the frame that scheduled them. */
export function install() {
  if (installed) return;
  installed = true;
  wrapFirstArguments(Promise.prototype, PROMISE_CONTINUATIONS, 2);
  wrapFirstArguments(globalThis, "setTimeout", 1);
  wrapFirstArguments(globalThis, "setInterval", 1);
  wrapFirstArguments(globalThis, "queueMicrotask", 1);
}
