import type { CollectionEntry } from "astro:content";

import { order, sections, type Section } from "./sections";

export { order, sections, type Section };

export const href = (id: string) => `/docs/${id}/`;

/** The section a page is in; unknown pages fail the build, like a missing excerpt. */
export function sectionOf(id: string): Section {
  const section = sections.find((candidate) => candidate.pages.includes(id));
  if (!section) throw new Error(`Docs: ${id} is not in src/lib/docs/nav.ts.`);
  return section;
}

/** Every listed page exists, and every page is listed. */
export function checkNav(entries: readonly CollectionEntry<"docs">[]) {
  const ids = new Set(entries.map((entry) => entry.id));
  const missing = order.filter((id) => !ids.has(id));
  if (missing.length) throw new Error(`Docs: nav.ts lists missing pages: ${missing.join(", ")}`);
  for (const id of ids) sectionOf(id);
}

export function neighbours(id: string) {
  const index = order.indexOf(id);
  return { previous: order[index - 1], next: order[index + 1] };
}
