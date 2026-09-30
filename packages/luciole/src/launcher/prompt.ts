import { createInterface } from "node:readline/promises";

/** Asks a yes/no question; answers no without a terminal to ask on. */
export type Confirm = (question: string) => Promise<boolean>;

export const askTerminal: Confirm = async (question) => {
  if (!process.stdin.isTTY) {
    console.error(`${question}\nNo terminal to confirm on: pass --yes to accept.`);
    return false;
  }
  const lines = createInterface({ input: process.stdin, output: process.stderr });
  try {
    return /^y(es)?$/i.test((await lines.question(`${question} [y/N] `)).trim());
  } finally {
    lines.close();
  }
};

export const acceptAll: Confirm = () => Promise.resolve(true);
