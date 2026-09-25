import { defineConfig } from "astro/config";

export default defineConfig({
  site: "https://github.com/sykar-f/airtty",
  // The page shows the example applications' real sources, read from the checkout.
  vite: { server: { fs: { allow: [".."] } } },
});
