#!/usr/bin/env bun
import { relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { scaffold } from "./src/scaffold";

const USAGE = "Usage: create-luciole [dir] [--no-skills]   (default: my-luciole-app)";
const args = process.argv.slice(2);
const positional = args.filter((arg) => arg !== "--no-skills");
if (args.includes("-h") || args.includes("--help")) {
  console.log(USAGE);
} else if (positional.length > 1 || positional[0]?.startsWith("-")) {
  console.error(USAGE);
  process.exitCode = 1;
} else {
  const target = resolve(positional[0] ?? "my-luciole-app");
  try {
    await scaffold({
      template: fileURLToPath(new URL("./template/", import.meta.url)),
      target,
      skills: !args.includes("--no-skills"),
    });
  } catch (error: unknown) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
  const directory = relative(process.cwd(), target) || ".";
  console.log(`Starter created: ${target}\nNext: cd ${directory} && bun install && bun run dev`);
}
