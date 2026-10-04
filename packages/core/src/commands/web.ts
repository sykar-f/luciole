import { prepareWebRuntime } from "../web-runtime";
import type { Command } from "./command";
/** `luciole web-runtime`: this ABI's web runtime, built ahead of `luciole build --web`. */
export const webRuntime: Command = {
  usage: "web-runtime",
  flags: {},
  async run() {
    console.log({ webRuntime: await prepareWebRuntime() });
  },
};
