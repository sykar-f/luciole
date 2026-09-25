import { prepareWebRuntime } from "../web-runtime";
import type { Command } from "./command";
/** `airtty web-runtime`: this ABI's web runtime, built ahead of `airtty build --web`. */
export const webRuntime: Command = {
  usage: "web-runtime",
  async run() {
    console.log({ webRuntime: await prepareWebRuntime() });
  },
};
