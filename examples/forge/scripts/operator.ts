#!/usr/bin/env bun
// The second operator of the demo: acts on the Forge database while a Client is open,
// to make concurrency and lost responses reproducible on stage. Local tool only: it is
// not a Server Function and never reachable from a Client.
import { z } from "zod";
import { createForge } from "../server/forge";
import { openDatabase } from "../server/schema";

const usage = `Usage: bun examples/forge/scripts/operator.ts <command>
  push <repo> <number>             push a new revision (approvals become stale)
  describe <repo> <number> <text>  edit a description (conflicts with a Draft)
  approve <repo> <number> [user]   approve as another user (default bob)
  lose <merge|review|publish>      the next such response is lost after commit
Database: FORGE_DB (default forge.sqlite)`;

const [command, ...args] = process.argv.slice(2);
const { FORGE_DB } = z.object({ FORGE_DB: z.string().default("forge.sqlite") }).parse(process.env);
const forge = createForge(openDatabase(FORGE_DB));
const number = (value: string | undefined) => {
  const parsed = z.coerce.number().int().safeParse(value);
  if (!parsed.success) throw new Error(usage);
  return parsed.data;
};

if (command === "push") {
  const revision = forge.operator.push(args[0], number(args[1]));
  console.log(`${args[0]}#${args[1]} is now at revision ${revision}`);
} else if (command === "describe") {
  const version = forge.operator.editDescription(args[0], number(args[1]), args.slice(2).join(" "));
  console.log(`${args[0]}#${args[1]} description is now version ${version}`);
} else if (command === "approve") {
  const login = forge.login(args[2] ?? "bob", "forge");
  const actor = login.ok ? forge.authenticate(login.token) : null;
  const pull = forge.pull(args[0], number(args[1]));
  if (!actor || !pull) throw new Error("Unknown user or pull request");
  console.log(
    forge.review(actor, {
      repo: args[0],
      number: pull.number,
      revision: pull.revision,
      verdict: "approve",
      operationId: crypto.randomUUID(),
    }),
  );
} else if (
  command === "lose" &&
  (args[0] === "merge" || args[0] === "review" || args[0] === "publish")
) {
  forge.operator.armFault(args[0]);
  console.log(`The next committed ${args[0]} response will be lost`);
} else {
  console.error(usage);
  process.exitCode = 1;
}
