import { inspect } from "node:util";

/**
 * Short, bounded text for a value the DevTools display: a console argument, a prop, a
 * hook's state. Never throws (getters, proxies, cycles) and never walks deep: it runs in
 * the inspected process, on its hot path.
 */
const MAX_TEXT = 200;
const MAX_CONSOLE_TEXT = 4000;
const truncate = (text: string, max: number) =>
  text.length > max ? `${text.slice(0, max - 1)}…` : text;

const elementName = (type: unknown): string => {
  if (typeof type === "string") return type;
  if (typeof type === "function") return type.name || "Anonymous";
  if (typeof type === "object" && type !== null) {
    if ("displayName" in type && typeof type.displayName === "string") return type.displayName;
    // Flight's Client references and lazy wrappers.
    if ("$$typeof" in type && typeof type.$$typeof === "symbol")
      return type.$$typeof.description ?? "Element";
  }
  return "Element";
};
const isElement = (value: unknown): value is { type: unknown } =>
  typeof value === "object" &&
  value !== null &&
  "$$typeof" in value &&
  typeof value.$$typeof === "symbol" &&
  "type" in value;

export function preview(value: unknown, max = MAX_TEXT): string {
  try {
    if (typeof value === "string") return truncate(JSON.stringify(value), max);
    if (typeof value === "function") return `ƒ ${value.name || "anonymous"}()`;
    if (typeof value !== "object" || value === null) return String(value);
    if (isElement(value)) return `<${elementName(value.type)} />`;
    if (Array.isArray(value)) return `Array(${value.length})`;
    return truncate(inspect(value, { depth: 0, breakLength: Infinity, compact: true }), max);
  } catch {
    return "[unreadable]";
  }
}

/** Console arguments as the terminal would print them: strings as is, the rest inspected. */
export function consoleText(args: readonly unknown[]): string {
  try {
    const text = args
      .map((arg) =>
        typeof arg === "string" ? arg : inspect(arg, { depth: 2, breakLength: Infinity }),
      )
      .join(" ");
    return truncate(text, MAX_CONSOLE_TEXT);
  } catch {
    return "[unreadable console arguments]";
  }
}

export const CONSOLE_LEVELS = ["log", "info", "warn", "error", "debug"] as const;
export type Level = (typeof CONSOLE_LEVELS)[number];
type Method = (...args: unknown[]) => void;

/**
 * Wraps the global console's methods: `onEntry` hears each call, then the method it
 * replaced runs as before (the terminal's own console, OpenTUI's capture, React's Flight
 * patch). Returns the function that restores them. A console replaced wholesale later
 * (OpenTUI activating its capture) is wrapped again by calling this again.
 */
export function captureConsole(onEntry: (level: Level, args: unknown[]) => void) {
  const target = globalThis.console;
  const originals = new Map<Level, Method>();
  let reentrant = false;
  for (const level of CONSOLE_LEVELS) {
    const original: Method = target[level].bind(target);
    originals.set(level, original);
    target[level] = (...args: unknown[]) => {
      // A listener that logs must not loop.
      if (!reentrant) {
        reentrant = true;
        try {
          onEntry(level, args);
        } catch {
          // The DevTools never break the application's logging.
        } finally {
          reentrant = false;
        }
      }
      original(...args);
    };
  }
  return {
    target,
    restore() {
      for (const [level, original] of originals) target[level] = original;
    },
  };
}
