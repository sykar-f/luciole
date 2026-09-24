// results.json gathers every measurement of this probe, one section per script, so that a
// partial rerun (only the widget, only the bench) keeps the other sections.
import { join } from "node:path";
import { z } from "zod";

const FILE = join(import.meta.dir, "results.json");
const Results = z.record(z.string(), z.unknown());

export async function saveSection(section: string, data: unknown) {
  const file = Bun.file(FILE);
  const current = (await file.exists()) ? Results.parse(await file.json()) : {};
  const next = {
    ...current,
    [section]: {
      date: new Date().toISOString(),
      bun: Bun.version,
      platform: `${process.platform}-${process.arch}`,
      ...Results.parse(data),
    },
  };
  await Bun.write(FILE, JSON.stringify(next, null, 2) + "\n");
}
