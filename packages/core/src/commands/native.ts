import { prepareNativeRuntime } from "../native-runtime";
import type { Command } from "./command";

/** Prepare a matching patched OpenTUI JS/native pair ahead of compilation. */
export const nativeRuntime: Command = {
  usage: "native-runtime [--target <target>]",
  flags: { "--target": "value" },
  async run({ optional }) {
    const target = optional("--target");
    console.log(await prepareNativeRuntime(target === undefined ? {} : { target }));
  },
};
