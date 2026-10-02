#!/usr/bin/env bun
import { relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { scaffold } from "./src/scaffold";

const USAGE = "Usage: create-luciole [dir]   (default: my-luciole-app)";
const args = process.argv.slice(2);
if (args.includes("-h") || args.includes("--help")) {
  console.log(USAGE);
} else if (args.length > 1 || args[0]?.startsWith("-")) {
  console.error(USAGE);
  process.exitCode = 1;
} else {
  const target = resolve(args[0] ?? "my-luciole-app");
  try {
    await scaffold({ template: fileURLToPath(new URL("./template/", import.meta.url)), target });
  } catch (error: unknown) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
  const directory = relative(process.cwd(), target) || ".";
  console.log(`Starter created: ${target}\nNext: cd ${directory} && bun install && bun run dev`);
}
