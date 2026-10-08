import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { readPackageJson } from "../package-json";
import { canGreet, mascotArt } from "../mascot";
import { frameworkRoot, workspaceRoot, type Command } from "./command";
import { installSkills, packagedMaterial } from "./skills";

/** The scaffolder package, published at the framework's own version. */
const CREATE_NAME = "@luciole-sh/create";
/** Where the scaffolder stages a starter that links a checkout, relative to the workspace. */
const WORKSPACE_STARTER = "packages/create/scripts/stage.ts";

/**
 * Whether the framework runs from an installed package or from the workspace.
 * Installed: the root has the layout a package manager gives a scoped dependency,
 * `<...>/node_modules/@luciole-sh/core` (the parent is the scope, the grandparent `node_modules`).
 * Any `node_modules` further up proves nothing: a workspace can be checked out beneath one, and
 * its `packages/core` then has the workspace's own layout, whose packages are linked from disk.
 */
export function isInstalled(root: string): boolean {
  const scope = dirname(root);
  return basename(scope) === "@luciole-sh" && basename(dirname(scope)) === "node_modules";
}

/** Runs a command with this process's terminal; resolves with its exit code. */
async function runInherited(command: string[]): Promise<number> {
  const child = Bun.spawn(command, { stdin: "inherit", stdout: "inherit", stderr: "inherit" });
  return child.exited;
}

/**
 * Writes a starter into `target`, by running the scaffolder:
 * - installed (`framework` lies in `node_modules`): `bunx @luciole-sh/create@<framework version>`,
 *   the release published with this framework, whose template holds nothing a repository would;
 * - from a workspace: the scaffolder's own staging script, which builds a starter from the
 *   workspace's Notes example that links the checkout's packages (development, `clean-install`).
 * `run` starts a command and gives its exit code (replaceable in tests).
 */
export async function createStarter(options: {
  target: string;
  framework: string;
  workspace: string;
  run?: (command: string[]) => Promise<number>;
}): Promise<void> {
  const { target, framework, workspace, run = runInherited } = options;
  let command: string[];
  if (isInstalled(framework)) {
    const { version } = await readPackageJson(join(framework, "package.json"));
    if (!version) throw new Error(`${framework}: no version`);
    command = [process.execPath, "x", `${CREATE_NAME}@${version}`, target];
  } else {
    command = [process.execPath, join(workspace, WORKSPACE_STARTER), "--workspace", target];
  }
  const code = await run(command);
  if (code !== 0) throw new Error(`Cannot create the starter: ${command.join(" ")} exited ${code}`);
}

export const init: Command = {
  usage: "init <dir>",
  flags: {},
  async run({ args }) {
    const target = resolve(args[1] ?? "my-luciole-app");
    await createStarter({ target, framework: frameworkRoot, workspace: workspaceRoot });
    // Every new app starts with the agent skills and the AGENTS.md block, at this version.
    await installSkills({
      ...(await packagedMaterial()),
      directory: target,
      home: homedir(),
      global: false,
      agents: ["agents", "claude"],
      dryRun: false,
      force: false,
      log: (line) => console.log(line),
      warn: (line) => console.error(line),
    });
    // The useful lines come first, from the scaffolder; the picture is a greeting, for a person
    // at a colour terminal.
    if (canGreet(process.stdout, process.env)) console.log(`\n${mascotArt()}`);
  },
};
