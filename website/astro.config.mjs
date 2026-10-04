import { fileURLToPath } from "node:url";
import { defineConfig, fontProviders } from "astro/config";
import mdx from "@astrojs/mdx";
import sitemap from "@astrojs/sitemap";
import { satteri } from "@astrojs/markdown-satteri";
import { night } from "./src/lib/codeTheme.ts";
import { glossaryLinks, headingAnchors, renameProduct } from "./src/lib/docs/markdown.ts";

// What src/assets/fonts/jetbrains-mono-symbols.woff2 draws (the last line subset.sh prints), so a
// page needs the file only when it holds one of these.
const SYMBOLS_RANGE = `
  U+2190, U+2192, U+2194-2199, U+219D-219E, U+21A0, U+21A2-21A3, U+21A5-21A7, U+21A9-21AA,
  U+21AD, U+21BE, U+21C9, U+21D0-21D4, U+21DB, U+21DE-21DF, U+21E5, U+21E7-21E8, U+21EA,
  U+2200-220C, U+220E-2211, U+2213, U+2218-221A, U+221E, U+2223-2225, U+2227-222B,
  U+2234-2239, U+223C, U+223E, U+2243, U+2245, U+2247-2249, U+224B, U+224D, U+2254, U+2257,
  U+225F-2265, U+226A-2273, U+227A-227C, U+2282-2289, U+228E-2299, U+229B-22A5, U+22B4,
  U+22B8, U+22BB-22BD, U+22C2-22C4, U+22C6, U+22C8-22CA, U+22CE, U+22D0, U+22E2, U+22EE-22F1,
  U+2302-2305, U+2308-230B, U+2318, U+231C-231F, U+2324-2326, U+2328, U+232B, U+2336-237A,
  U+2389-238B, U+2395, U+239B-23AD, U+23CE, U+23FB-23FE, U+2500-25A1, U+25AA-25AB,
  U+25B2-25CC, U+25CE-25CF, U+25D4-25D5, U+25E6-25EB, U+25EF, U+25F6, U+266D, U+266F, U+2687,
  U+26A0-26A1, U+2713, U+2715, U+2717, U+2736, U+276E-2771, U+2794, U+279C-279E
`
  .trim()
  .split(/,\s*/);

// The Fontsource files the site uses, vendored under src/assets/fonts/<family>/ (vendor.sh
// there refetches them), so `astro build` makes no request for fonts. Same bytes and same
// unicode-ranges as the Fontsource provider gave, and each face carries its `subset`, which
// the preloads of Base.astro select on (the local provider cannot name one).
/** @type {Record<string, string>} */
const FONT_SUBSET_RANGES = {
  latin: `U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, U+0304, U+0308,
    U+0329, U+2000-206F, U+20AC, U+2122, U+2191, U+2193, U+2212, U+2215, U+FEFF, U+FFFD`,
  "latin-ext": `U+0100-02BA, U+02BD-02C5, U+02C7-02CC, U+02CE-02D7, U+02DD-02FF, U+0304, U+0308,
    U+0329, U+1D00-1DBF, U+1E00-1E9F, U+1EF2-1EFF, U+2020, U+20A0-20AB, U+20AD-20C0, U+2113,
    U+2C60-2C7F, U+A720-A7FF`,
};

/**
 * Files are `<dir>/<subset>-<weight>-<style>.woff2`; `wght` stands for the variable axis.
 * @type {import("astro").FontProvider<{ dir: string }>}
 */
const vendoredFonts = {
  name: "vendored",
  resolveFont({ familyName, weights, styles, subsets, options }) {
    const fonts = [];
    for (const subset of subsets) {
      const ranges = FONT_SUBSET_RANGES[subset];
      if (!ranges) throw new Error(`${familyName}: no unicode-range for the "${subset}" subset`);
      for (const weight of weights) {
        for (const style of styles) {
          const file = `${subset}-${weight.includes(" ") ? "wght" : weight}-${style}.woff2`;
          fonts.push({
            src: [
              {
                url: fileURLToPath(
                  new URL(`./src/assets/fonts/${options.dir}/${file}`, import.meta.url),
                ),
              },
            ],
            weight,
            style,
            unicodeRange: ranges.split(/,\s*/),
            meta: { subset },
          });
        }
      }
    }
    return { fonts };
  },
};

// The French guide left the site once /docs held its content: each of its old URLs opens the
// English page that took that chapter over.
const GUIDE_REDIRECTS = {
  "/guide": "/docs/",
  "/guide/carte": "/docs/concepts/client-and-server/",
  "/guide/build": "/docs/reference/build-and-distribution/",
  "/guide/demarrage": "/docs/guides/opening-an-app/",
  "/guide/navigation": "/docs/concepts/routing/",
  "/guide/server-functions": "/docs/concepts/server-functions/",
  "/guide/cache": "/docs/concepts/cache/",
  "/guide/session": "/docs/concepts/session-restore/",
  "/guide/distribution": "/docs/reference/build-and-distribution/",
  "/guide/web-desktop": "/docs/guides/opening-an-app/#open-an-app-in-a-browser",
  "/guide/devtools": "/docs/guides/devtools/",
  "/guide/glossaire": "/docs/reference/glossary/",
};

export default defineConfig({
  site: "https://luciole.sh",
  redirects: GUIDE_REDIRECTS,
  // `cloudflared tunnel --url http://localhost:4321` shares a local preview: its host.
  server: { allowedHosts: [".trycloudflare.com"] },
  // The page shows the example applications' real sources, read from the checkout.
  vite: { server: { fs: { allow: [".."] } } },
  // The documentation (src/content/docs): its code blocks take the palette's colours, like
  // every excerpt on the site.
  // The sitemap leaves out the pages Base.astro marks `hidden` (noindex): the og card's page
  // and the lab prototypes.
  integrations: [
    mdx(),
    sitemap({ filter: (page) => !/^\/(og|lab)(\/|$)/.test(new URL(page).pathname) }),
  ],
  // Vendored (src/assets/fonts), preloaded from the head (Base.astro) and given metric-matched fallbacks, so
  // the first paint already has the fonts or text that does not move when they arrive.
  // global.css maps these variables onto --mono, --sans and --term.
  fonts: [
    {
      provider: vendoredFonts,
      options: { dir: "ibm-plex-mono" },
      name: "IBM Plex Mono",
      cssVariable: "--font-plex-mono",
      weights: ["400", "500", "600", "700"],
      styles: ["normal"],
      subsets: ["latin", "latin-ext"],
      fallbacks: [],
    },
    {
      provider: vendoredFonts,
      options: { dir: "ibm-plex-sans" },
      name: "IBM Plex Sans",
      cssVariable: "--font-plex-sans",
      weights: ["400", "600"],
      styles: ["normal", "italic"],
      subsets: ["latin", "latin-ext"],
      fallbacks: ["ui-sans-serif", "system-ui", "sans-serif"],
    },
    {
      provider: vendoredFonts,
      options: { dir: "jetbrains-mono" },
      name: "JetBrains Mono",
      cssVariable: "--font-jetbrains-mono",
      weights: ["100 800"],
      styles: ["normal"],
      subsets: ["latin", "latin-ext"],
      fallbacks: ["ui-monospace", "monospace"],
    },
    // The arrows, maths, box and block glyphs the Fontsource subsets leave out, cut from the full
    // font (src/assets/fonts/subset.sh) and named like it, so the browser takes them from here.
    // Fetched only by a page that draws one of them; Base.astro renders it without a preload.
    {
      provider: fontProviders.local(),
      name: "JetBrains Mono",
      cssVariable: "--font-jetbrains-symbols",
      fallbacks: [],
      options: {
        variants: [
          {
            src: ["./src/assets/fonts/jetbrains-mono-symbols.woff2"],
            weight: "100 800",
            style: "normal",
            unicodeRange: SYMBOLS_RANGE,
          },
        ],
      },
    },
  ],
  markdown: {
    shikiConfig: { theme: night },
    processor: satteri({ hastPlugins: [headingAnchors, renameProduct, glossaryLinks] }),
  },
});
