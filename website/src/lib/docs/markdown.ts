import Slugger from "github-slugger";
import type { SatteriProcessorOptions } from "@astrojs/markdown-satteri";
import { name, writtenAs } from "../product";

// Hast plugins of the documentation's Markdown (astro.config.mjs). They run before
// Astro's own heading ids, which keep an id already set.
type HastPluginEntry = NonNullable<SatteriProcessorOptions["hastPlugins"]>[number];

/**
 * An anchor after each h2 and h3, to link to a section. The heading gets its id here, by
 * the slugger Astro uses, so the anchor knows it; the anchor holds no text (its mark is
 * drawn by CSS), so the table of contents reads the heading alone.
 */
export const headingAnchors: HastPluginEntry = () => {
  const slugger = new Slugger();
  return {
    name: "heading-anchors",
    element: {
      filter: ["h2", "h3"],
      visit(node, ctx) {
        const given = node.properties?.id;
        const id = typeof given === "string" ? given : slugger.slug(ctx.textContent(node));
        ctx.setProperty(node, "id", id);
        ctx.appendChild(node, {
          type: "element",
          tagName: "a",
          properties: { className: ["anchor"], href: `#${id}`, ariaLabel: "Link to this section" },
          children: [],
        });
      },
    },
  };
};

/**
 * The product's name as `product.ts` gives it, in the text of every page, code included:
 * `luciole`, `LUCIOLE_` and `.luciole/` follow a rename. Nothing to do while the name is the
 * one the pages are written with.
 */
export const renameProduct: HastPluginEntry = () =>
  name !== writtenAs && {
    name: "rename-product",
    text(node, ctx) {
      const renamed = node.value
        .replaceAll(writtenAs, name)
        .replaceAll(writtenAs.toUpperCase(), name.toUpperCase());
      if (renamed !== node.value) ctx.replaceNode(node, { type: "text", value: renamed });
    },
  };
