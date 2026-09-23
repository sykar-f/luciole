import { useSyncExternalStore } from "react";
import { z } from "zod";

// View preferences live above the routes: they survive every directory change, and never
// reach the Server (sorting and hiding dotfiles are local work on the listing).

export const SORTS = ["name", "size", "modified"] as const;
export type Sort = (typeof SORTS)[number];
// `auto` asks OpenTUI: kitty graphics when the terminal answers its query, else half blocks.
// Forcing `blocks` helps behind a multiplexer that answers the query but drops the images.
export const PROTOCOLS = ["auto", "kitty", "blocks"] as const;
export type Protocol = (typeof PROTOCOLS)[number];

type Prefs = { hidden: boolean; sort: Sort; protocol: Protocol };

const ProtocolEnv = z.enum(PROTOCOLS).optional();
let prefs: Prefs = {
  hidden: false,
  sort: "name",
  protocol: ProtocolEnv.catch(undefined).parse(process.env.FILES_IMAGE_PROTOCOL) ?? "auto",
};
const listeners = new Set<() => void>();

export const prefsStore = {
  get: () => prefs,
  update: (patch: Partial<Prefs>) => {
    prefs = { ...prefs, ...patch };
    for (const listener of listeners) listener();
  },
  subscribe: (listener: () => void) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
};

export const usePrefs = () => useSyncExternalStore(prefsStore.subscribe, prefsStore.get);

/** The value after `current` in `values`, wrapping around. */
export const next = <T>(values: readonly T[], current: T) =>
  values[(values.indexOf(current) + 1) % values.length];
