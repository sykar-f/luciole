/** The launcher is waiting for its application's argument declaration. */
import { main } from "../packages/core/src/launcher/binary";
await main("luciole-binary:1:startup:abc:bun-darwin-arm64;", {
  server: async () => {
    throw new Error("No Server should start");
  },
  client: async () => {
    throw new Error("No Client should start");
  },
  args: async () => {
    process.send?.({ waiting: true });
    return new Promise<never>(() => {});
  },
});
