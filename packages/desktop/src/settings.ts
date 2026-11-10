/**
 * The application's settings of its window (`luciole.desktop`, @luciole-sh/core/metadata):
 * the host sends them once, before the program starts (src/host/session.ts), and the view
 * applies them to xterm.js (src/view). Until then the view takes no keys: what Option
 * types is not known yet.
 */
import type { AppMetadata } from "@luciole-sh/core/metadata";

export type WindowSettings = { macOptionIsMeta: boolean };

/** Option is Meta unless the application lets it compose characters. */
export const windowSettings = (metadata: AppMetadata): WindowSettings => ({
  macOptionIsMeta: metadata.desktop?.macOptionIsMeta ?? true,
});

type TerminalOptions = { macOptionIsMeta?: boolean; disableStdin?: boolean };

/** The view's options before the settings arrive. */
export const BEFORE_SETTINGS = { macOptionIsMeta: true, disableStdin: true } as const;

/** Applies the settings, then lets keys through. */
export function applySettings(terminal: { options: TerminalOptions }, settings: WindowSettings) {
  terminal.options.macOptionIsMeta = settings.macOptionIsMeta;
  terminal.options.disableStdin = false;
}
