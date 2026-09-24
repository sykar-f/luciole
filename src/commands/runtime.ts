import { fetchRuntime } from "../compile";
import type { Command } from "./command";
export const runtime: Command = {
  usage: "runtime [--target t]",
  async run({ optional }) {
    console.log(await fetchRuntime(optional("--target")));
  },
};
