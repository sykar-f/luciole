import { defineConfig } from "astro/config";
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
  markdown: {
    shikiConfig: { theme: night },
    processor: satteri({ hastPlugins: [headingAnchors, renameProduct] }),
  },
});
