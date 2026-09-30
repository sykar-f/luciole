"use server";
import { invalidate } from "luciole/server";
import { z } from "zod";
import { messageOf } from "../../../guards";
import { install, remove, update } from "../../../registry/apps";
import { parsePackageSpec } from "../../../registry/registry";
import { resolveTarget } from "../../target";
import type { Found, Outcome } from "../components/model";
import { handOff, paths, registry } from "../server/context";

// Arguments arrive from the Client unchecked: each action validates its own.
const MAX_TEXT = 500;
const Text = z.string().trim().min(1).max(MAX_TEXT);
const Names = z.array(Text);
const options = { registry, directories: paths, log: () => {} };

// Failures are answered, not thrown: a thrown error reaches the Client as a generic 500,
// and the launcher shows the registry's own explanation.
async function outcome<T>(run: () => Promise<T>): Promise<Outcome<T>> {
  try {
    return { ok: true, value: await run() };
  } catch (error: unknown) {
    return { ok: false, error: messageOf(error) };
  }
}

export async function searchApps(text: unknown): Promise<Outcome<Found[]>> {
  return outcome(async () => [
    ...(await registry.search(z.string().max(MAX_TEXT).parse(text).trim())),
  ]);
}

/** Installs `spec` (the launcher's list is the confirmation); answers the app's name. */
export async function installApp(spec: unknown): Promise<Outcome<string>> {
  return outcome(async () => {
    const parsed = parsePackageSpec(Text.parse(spec));
    if (!parsed) throw new Error(`${String(spec)} is not an npm package`);
    const { installed } = await install(parsed, options);
    invalidate();
    return installed.app;
  });
}

export async function updateApps(names: unknown): Promise<Outcome<string>> {
  return outcome(async () => {
    const results = await update(Names.parse(names), options);
    invalidate();
    const changed = results.filter((r) => r.changed);
    return changed.length
      ? changed.map((r) => `${r.installed.app} ${r.from} → ${r.installed.version}`).join(", ")
      : "Everything is up to date";
  });
}

export async function removeApp(name: unknown): Promise<Outcome<string>> {
  return outcome(async () => {
    const app = Text.parse(name);
    await remove(app, paths);
    invalidate();
    return app;
  });
}

/** Checks `target` resolves, then hands it to `luciole` to launch after this quits. */
export async function launchTarget(target: unknown): Promise<Outcome<string>> {
  return outcome(async () => {
    const text = Text.parse(target);
    resolveTarget(text, { directories: paths });
    await handOff(text);
    return text;
  });
}
