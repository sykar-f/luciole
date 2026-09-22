// Shared by the Server page (which applies the filter) and the Client list (which
// changes it). Not a "use client" module: on the Server its values stay plain data.
export const STATES = ["open", "merged", "all"] as const;
export type StateFilter = (typeof STATES)[number];
export const stateOf = (value: string | undefined): StateFilter =>
  STATES.find((s) => s === value) ?? "open";
