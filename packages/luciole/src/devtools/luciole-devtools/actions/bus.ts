"use server";
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import * as z from "zod/mini";
import { toHar } from "../../model/har";
import { createSession } from "../../model/session";
import { message, PLUGIN } from "../../protocol";
import { parseCommand } from "../../schema";
import * as store from "../server/store";

// A burst of events (a stream's chunks) reaches the Client as one batch.
const BATCH_MS = 50;
const MAX_BATCH = 2000;
// Wakes an idle subscription now and then: a Client gone meanwhile lets it end.
const HEARTBEAT_MS = 15_000;
const Cursor = z.number().check(z.int(), z.gte(0));

/**
 * The live feed of the DevTools' Client: every stored event after `since`, in batches,
 * with the processes connected. Ends when the Client cancels it.
 */
export async function* subscribe(since: unknown) {
  let cursor = Cursor.parse(since);
  while (true) {
    const { events, missed } = store.after(cursor, MAX_BATCH);
    const last = events.at(-1);
    if (last) cursor = last.seq;
    yield {
      events,
      missed,
      sources: store.listSources(),
      rejected: store.rejectedCount(),
      connect: store.connectInfo,
    };
    if (events.length === MAX_BATCH) continue;
    await Promise.race([store.changed(), sleep(HEARTBEAT_MS)]);
    await sleep(BATCH_MS);
  }
}

const Role = z.enum(["client", "server"]);
/** Forwards a command (`luciole-devtools:<suffix>`) to the inspected processes of `role`. */
export async function command(role: unknown, suffix: unknown, payload: unknown) {
  const target = Role.parse(role);
  const parsed = parseCommand(message(PLUGIN.control, z.string().parse(suffix), payload));
  if (!parsed) throw new Error("Invalid DevTools command");
  return { sent: store.send(target, parsed) };
}

export async function clearEvents() {
  store.clear();
  return { ok: true };
}

/**
 * Writes the session where `luciole devtools` runs: the raw event log, which
 * `luciole devtools --replay <file>` reopens, and a HAR of the Network panel.
 */
export async function exportRecording() {
  const events = store.all();
  const session = createSession();
  for (const stored of events) session.add(stored);
  const stamp = new Date().toISOString().replaceAll(/[:.]/g, "-");
  const base = resolve(`luciole-devtools-${stamp}`);
  await writeFile(
    `${base}.json`,
    JSON.stringify({ version: 1, sources: store.listSources(), events }, null, 1),
  );
  await writeFile(
    `${base}.har`,
    JSON.stringify(toHar(session.network.rows(), session.network.derive()), null, 1),
  );
  return { json: `${base}.json`, har: `${base}.har`, events: events.length };
}
