/** Exercise the binary's actual runtime parser without starting a Server or renderer. */
import { main } from "../packages/core/src/launcher/binary";
const report = () =>
  console.log(JSON.stringify({ pixelScroll: process.env.LUCIOLE_PIXEL_SCROLL ?? null }));
await main("luciole-binary:1:pixel:abcd:bun-darwin-arm64;", {
  server: async () => report(),
  client: async () => ({ createApp() {}, run: report }),
});
