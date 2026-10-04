import { defineConfig, fontProviders } from "astro/config";
import mdx from "@astrojs/mdx";
import { satteri } from "@astrojs/markdown-satteri";
import { night } from "./src/lib/codeTheme.ts";
import { headingAnchors, renameProduct } from "./src/lib/docs/markdown.ts";

export default defineConfig({
  site: "https://github.com/sykar-f/luciole",
  // `cloudflared tunnel --url http://localhost:4321` shares a local preview: its host.
  server: { allowedHosts: [".trycloudflare.com"] },
  // The page shows the example applications' real sources, read from the checkout.
  vite: { server: { fs: { allow: [".."] } } },
  // The documentation (src/content/docs): its code blocks take the palette's colours, like
  // every excerpt on the site.
  integrations: [mdx()],
  // Self-hosted, preloaded from the head (Base.astro) and given metric-matched fallbacks, so
  // the first paint already has the fonts or text that does not move when they arrive.
  // global.css maps these variables onto --mono, --sans and --term.
  fonts: [
    {
      provider: fontProviders.fontsource(),
      name: "IBM Plex Mono",
      cssVariable: "--font-plex-mono",
      weights: ["400", "500", "600", "700"],
      styles: ["normal"],
      subsets: ["latin", "latin-ext"],
      fallbacks: [],
    },
    {
      provider: fontProviders.fontsource(),
      name: "IBM Plex Sans",
      cssVariable: "--font-plex-sans",
      weights: ["400", "600"],
      styles: ["normal", "italic"],
      subsets: ["latin", "latin-ext"],
      fallbacks: ["ui-sans-serif", "system-ui", "sans-serif"],
    },
    {
      provider: fontProviders.fontsource(),
      name: "JetBrains Mono",
      cssVariable: "--font-jetbrains-mono",
      weights: ["100 800"],
      styles: ["normal"],
      subsets: ["latin", "latin-ext"],
      fallbacks: ["ui-monospace", "monospace"],
    },
  ],
  markdown: {
    shikiConfig: { theme: night },
    processor: satteri({ hastPlugins: [headingAnchors, renameProduct] }),
  },
});
