import { hostTarget } from "../compile";
import { directories } from "../launcher/paths";
import { acceptAll, askTerminal } from "../launcher/prompt";
import {
  install as installApp,
  listInstalled,
  remove as removeApp,
  update as updateApps,
} from "../registry/apps";
import { npmRegistry } from "../registry/npm";
import { formatSpec, parsePackageSpec } from "../registry/registry";
import type { Command, CommandContext } from "./command";

// Registry subcommands. What is installed lives in $XDG_DATA_HOME/airtty/apps
// (src/registry/apps.ts); the registry is only read.
const operands = ({ args }: CommandContext) => args.slice(1).filter((arg) => !arg.startsWith("--"));
const options = (context: CommandContext) => ({
  registry: npmRegistry(),
  directories: directories(),
  log: (message: string) => console.error(message),
  confirm: context.args.includes("--yes") ? acceptAll : askTerminal,
});

export const search: Command = {
  usage: "search [text]",
  async run(context) {
    const found = await npmRegistry().search(operands(context).join(" "));
    if (!found.length) console.log("No app found.");
    for (const hit of found)
      console.log(`${hit.package}@${hit.version}${hit.description ? `  ${hit.description}` : ""}`);
  },
};

export const install: Command = {
  usage: "install <npm spec>… [--yes]",
  async run(context) {
    const specs = operands(context);
    if (!specs.length) throw new Error("Usage: airtty install <npm spec>… [--yes]");
    for (const text of specs) {
      const spec = parsePackageSpec(text);
      if (!spec) throw new Error(`${text} is not an npm package spec`);
      const { installed, changed } = await installApp(spec, options(context));
      console.log(
        `${installed.app}: ${installed.package}@${installed.version}` +
          `${changed ? "" : " (already installed)"} — run it with: airtty ${installed.app}`,
      );
    }
  },
};

export const update: Command = {
  usage: "update [app…]",
  async run(context) {
    const results = await updateApps(operands(context), options(context));
    if (!results.length) console.log("No app installed.");
    for (const { installed, changed, from } of results)
      console.log(
        `${installed.app}: ${changed ? `${from} → ${installed.version}` : `${installed.version}, up to date`}`,
      );
  },
};

export const list: Command = {
  usage: "list",
  async run() {
    const all = await listInstalled(directories());
    if (!all.length) console.log("No app installed.");
    for (const app of all)
      console.log(
        `${app.app}  ${formatSpec({ name: app.package, range: app.range })} → ${app.version}` +
          `  build ${app.buildId}${app.target === hostTarget() ? "" : ` (${app.target})`}`,
      );
  },
};

export const remove: Command = {
  usage: "remove <app>…",
  async run(context) {
    const names = operands(context);
    if (!names.length) throw new Error("Usage: airtty remove <app>…");
    for (const name of names) {
      await removeApp(name, directories());
      console.log(`${name} removed`);
    }
  },
};
