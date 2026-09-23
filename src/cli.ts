#!/usr/bin/env bun
import { basename, resolve, join } from "node:path";
import { watch } from "node:fs";
import { cp, mkdir, readdir, symlink } from "node:fs/promises";
import { spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import { build } from "./build";
import { compileClient, fetchRuntime } from "./compile";
const args = process.argv.slice(2),
  command = args[0];
const option = (key: string, fallback: string) => {
  const i = args.indexOf(key);
  return i < 0 ? fallback : args[i + 1];
};
const optional = (key: string) => {
  const i = args.indexOf(key);
  return i < 0 ? undefined : args[i + 1];
};
const directory = resolve(option("--app", "examples/notes"));
async function stop(child?: ChildProcess) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((done) => {
    const timer = setTimeout(() => child.kill("SIGKILL"), 1500);
    child.once("exit", () => {
      clearTimeout(timer);
      done();
    });
    child.kill("SIGTERM");
  });
}
async function main() {
  if (command === "init") {
    const target = resolve(args[1] ?? "my-airtty-app");
    if ((await readdir(target).catch(() => [] as string[])).length)
      throw new Error("Target already contains a project");
    await mkdir(target, { recursive: true });
    await cp(resolve(import.meta.dir, "../examples/notes"), target, {
      recursive: true,
      filter: (p) =>
        !p.includes(".airtty") &&
        !p.endsWith(".sqlite") &&
        !p.endsWith(".sqlite-wal") &&
        !p.endsWith(".sqlite-shm"),
    });
    const frameworkRoot = resolve(import.meta.dir, "..");
    const frameworkPackage = await Bun.file(join(frameworkRoot, "package.json")).json();
    await Bun.write(
      join(target, "package.json"),
      JSON.stringify(
        {
          private: true,
          type: "module",
          packageManager: frameworkPackage.packageManager,
          dependencies: {
            ...frameworkPackage.dependencies,
            airtty: `file:${frameworkRoot}`,
          },
          devDependencies: frameworkPackage.devDependencies,
          overrides: frameworkPackage.overrides,
          scripts: {
            dev: "airtty dev --app .",
            build: "airtty build --app .",
            check: "tsc --noEmit",
            lint: "oxlint --deny-warnings .",
            "lint:fix": "oxlint --fix .",
            format: "oxfmt --write .",
            "format:check": "oxfmt --check .",
            verify: "bun run check && bun run lint && bun run format:check && bun run build",
          },
        },
        null,
        2,
      ),
    );
    await Bun.write(
      join(target, "tsconfig.json"),
      JSON.stringify(
        {
          extends: "airtty/tsconfig",
          include: ["app", "components", "actions", "server"],
          exclude: ["node_modules", ".airtty"],
        },
        null,
        2,
      ) + "\n",
    );
    for (const file of [
      ".oxlintrc.json",
      ".oxfmtrc.json",
      ".vscode",
      ".gitignore",
      ".bun-version",
    ]) {
      await cp(join(frameworkRoot, file), join(target, file), { recursive: true });
    }
    const { format } = await import("oxfmt");
    const { printWidth, sortImports, sortPackageJson } = await Bun.file(
      join(frameworkRoot, ".oxfmtrc.json"),
    ).json();
    for (const name of ["package.json", "tsconfig.json"]) {
      const file = Bun.file(join(target, name));
      const result = await format(name, await file.text(), {
        printWidth,
        sortImports,
        sortPackageJson,
      });
      if (result.errors.length) throw new Error(`Cannot format generated ${name}`);
      await Bun.write(file, result.code);
    }
    console.log(`Starter created: ${target}\nRun bun install in the starter, then bun run dev.`);
    return;
  }
  if (command === "build") {
    const result = await build(directory);
    console.log(result);
    if (!args.includes("--compile")) return;
    const compiled = await compileClient(result.output, {
      name: basename(directory),
      target: optional("--target"),
      outfile: optional("--outfile"),
      runtime: optional("--runtime"),
      nativeDir: optional("--native-dir"),
    });
    console.log({ client: compiled.outfile, target: compiled.target });
    if (compiled.warning) console.error(`Warning: ${compiled.warning}`);
    return;
  }
  if (command === "runtime") {
    console.log(await fetchRuntime(optional("--target")));
    return;
  }
  if (command === "start") {
    const role = option("--role", "server");
    if (!["client", "server"].includes(role)) throw new Error("role must be server or client");
    const artifact = resolve(option("--artifact", join(directory, ".airtty", role)), "index.js");
    const child = spawn(
      process.execPath,
      [
        ...(role === "server" ? ["--conditions=react-server"] : []),
        artifact,
        ...(role === "client" ? ["--url", option("--url", "http://127.0.0.1:3000")] : []),
      ],
      { stdio: "inherit", env: { ...process.env, NODE_ENV: "production" } },
    );
    for (const signal of ["SIGINT", "SIGTERM"] as const)
      process.on(signal, async () => {
        await stop(child);
        process.exit(0);
      });
    child.on("exit", (code) => process.exit(code ?? 1));
    return;
  }
  if (command === "dev") {
    let server: ChildProcess | undefined,
      client: ChildProcess | undefined,
      closing = false,
      building = false,
      again = false;
    const shutdown = async () => {
      if (closing) return;
      closing = true;
      watcher.close();
      clearTimeout(debounce);
      await Promise.all([stop(client), stop(server)]);
      process.exit(0);
    };
    async function rebuild() {
      if (closing) return;
      if (building) {
        again = true;
        return;
      }
      building = true;
      do {
        again = false;
        try {
          await build(directory);
          // Development reuses the framework installation, even for a starter elsewhere.
          await symlink(
            resolve(import.meta.dir, "../node_modules"),
            join(directory, ".airtty/node_modules"),
            "dir",
          );
          if (closing) break;
          await Promise.all([stop(client), stop(server)]);
          server = spawn(
            process.execPath,
            ["--conditions=react-server", join(directory, ".airtty/server/index.js")],
            {
              stdio: ["ignore", "pipe", "inherit"],
              env: { ...process.env, PORT: process.env.PORT ?? "0" },
            },
          );
          const activeServer = server;
          const ready = await new Promise<any>((yes, no) => {
            const timer = setTimeout(() => no(new Error("Server startup timeout")), 10000);
            const lines = createInterface({ input: activeServer.stdout! });
            activeServer.once("exit", () => {
              clearTimeout(timer);
              no(new Error("Server exited before ready"));
            });
            lines.on("line", (line) => {
              try {
                const msg = JSON.parse(line);
                if (msg.ready) {
                  clearTimeout(timer);
                  yes(msg);
                }
              } catch {
                console.error(line);
              }
            });
          });
          if (closing) break;
          console.error(
            "Rebuild ready. A successful rebuild restarts the Client and clears session Drafts.",
          );
          client = spawn(
            process.execPath,
            [join(directory, ".airtty/client/index.js"), "--url", `http://127.0.0.1:${ready.port}`],
            { stdio: ["inherit", "inherit", "inherit", "ipc"] },
          );
          const activeClient = client;
          activeClient.once("exit", () => {
            if (client === activeClient && !building) void shutdown();
          });
        } catch (error) {
          const message = `Build failed: ${(error as Error).message}`;
          if (client?.connected) client.send({ type: "build-error", message });
          else console.error(message);
        }
      } while (again && !closing);
      building = false;
    }
    let debounce: ReturnType<typeof setTimeout>;
    const watcher = watch(directory, { recursive: true }, (_event, file) => {
      if (
        !file ||
        file.includes(".airtty") ||
        file.includes("node_modules") ||
        // Written by the build itself when the route graph changes.
        file.endsWith("routeTree.gen.ts") ||
        !/\.(tsx?|jsx?)$/.test(file)
      )
        return;
      clearTimeout(debounce);
      debounce = setTimeout(() => void rebuild(), 150);
    });
    for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, shutdown);
    await rebuild();
    return;
  }
  throw new Error(
    "Usage: airtty init <dir> | dev | build [--compile [--target t] [--runtime official|host|<bun>] [--native-dir dir] [--outfile f]] | runtime [--target t] | start --role server|client [--app dir] [--url URL] [--artifact dir]",
  );
}
main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
