/** An installed app, as the launcher lists it. */
export type InstalledApp = { app: string; package: string; version: string; range?: string };
/** A registry search hit. */
export type Found = { package: string; version: string; description?: string };
/** What a launcher action answers: its value, or why it failed, for the status line. */
export type Outcome<T> = { ok: true; value: T } | { ok: false; error: string };
