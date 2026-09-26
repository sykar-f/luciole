import { defineConfig } from "astro/config";

export default defineConfig({
  site: "https://github.com/sykar-f/airtty",
  // `cloudflared tunnel --url http://localhost:4321` shares a local preview: its host.
  server: { allowedHosts: [".trycloudflare.com"] },
  // The page shows the example applications' real sources, read from the checkout.
  vite: { server: { fs: { allow: [".."] } } },
});
