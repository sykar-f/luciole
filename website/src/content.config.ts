import { defineCollection } from "astro:content";
import { glob } from "astro/loaders";
import { z } from "astro/zod";

// The documentation: one MDX file per page, its place in the sidebar given by
// src/lib/docs/nav.ts, which fails the build for a page it does not list.
const docs = defineCollection({
  loader: glob({ pattern: "**/*.mdx", base: "./src/content/docs" }),
  schema: z.object({
    title: z.string(),
    /** One sentence: the page's meta description and its line in the overview. */
    description: z.string(),
    /** Repository files the page describes, linked at its end; a missing one fails the build. */
    sources: z.array(z.string()).default([]),
  }),
});

export const collections = { docs };
