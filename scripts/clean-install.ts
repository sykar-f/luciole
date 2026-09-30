import { mkdtemp, cp, rm, mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { z } from "zod";

// The first line a production Server prints once it listens (src/server.ts).
const ServerReady = z.object({ ready: z.literal(true), port: z.number().int() });
const temp = await mkdtemp(join(tmpdir(), "luciole-release-"));
async function run(cmd: string[], cwd: string) {
  const child = Bun.spawn(cmd, {
    cwd,
    stdout: "inherit",
    stderr: "inherit",
    env: process.env,
  });
  if ((await child.exited) !== 0) throw new Error(`Failed: ${cmd.join(" ")}`);
}
try {
  const checkout = join(temp, "checkout");
  await mkdir(checkout);
  for (const name of [
    "packages",
    "examples",
    "package.json",
    "scripts/check.ts",
    "bun.lock",
    "bunfig.toml",
    "tsconfig.json",
    ".oxlintrc.json",
    ".oxfmtrc.json",
    ".vscode",
    ".gitignore",
    ".bun-version",
  ])
    await cp(resolve(name), join(checkout, name), {
      recursive: true,
      filter: (p) =>
        !p.includes(".luciole") &&
        !p.endsWith(".sqlite") &&
        !p.endsWith(".sqlite-shm") &&
        !p.endsWith(".sqlite-wal"),
    });
  await run([process.execPath, "install", "--frozen-lockfile"], checkout);
  await run([process.execPath, "run", "check"], checkout);
  await run(
    [process.execPath, "packages/luciole/src/cli.ts", "init", join(temp, "starter")],
    checkout,
  );
  const starter = join(temp, "starter");
  await run([process.execPath, "install"], starter);
  await run([process.execPath, "run", "check"], starter);
  await run([process.execPath, "run", "lint"], starter);
  await run([process.execPath, "run", "format:check"], starter);
  // Exercise the IDE's exact Node/Bun types, and prove that real type errors are still rejected.
  const typeProbe = join(starter, "server/typecheck-proof.ts");
  await Bun.write(
    typeProbe,
    'import {join} from "node:path";\nexport const path = join(process.cwd(), "notes");\nexport const pid: string = process.pid;\n',
  );
  try {
    const check = Bun.spawn([process.execPath, "run", "check"], {
      cwd: starter,
      stdout: "pipe",
      stderr: "pipe",
    });
    const output =
      (await new Response(check.stdout).text()) + (await new Response(check.stderr).text());
    if (
      (await check.exited) === 0 ||
      !output.includes("TS2322") ||
      output.includes("TS2307") ||
      output.includes("TS2580")
    ) {
      throw new Error(`Starter type-check did not report the expected assignment error: ${output}`);
    }
  } finally {
    await rm(typeProbe);
  }
  await run([process.execPath, "run", "build"], starter);
  // The built roles run from the starter's own installation: an app ships to another
  // machine as a compiled binary (luciole build --compile), not as .luciole/ to install.
  const built = join(starter, ".luciole");
  const child = Bun.spawn(
    [process.execPath, "--conditions=react-server", join(built, "server/index.js")],
    {
      cwd: temp,
      env: {
        ...process.env,
        NODE_ENV: "production",
        PORT: "0",
        NOTES_DB: join(temp, "notes.sqlite"),
        NOTES_DELAY_MS: "700",
      },
      stdout: "pipe",
      stderr: "inherit",
    },
  );
  try {
    const reader = child.stdout.getReader();
    let line = "";
    while (!line.includes("\n")) {
      const chunk = await reader.read();
      if (chunk.done) throw new Error("Server did not start");
      line += new TextDecoder().decode(chunk.value);
    }
    const ready = ServerReady.parse(JSON.parse(line.split("\n")[0]));
    await run(
      [
        process.execPath,
        "scripts/pty/smoke.ts",
        "--client",
        join(built, "client/index.js"),
        "--url",
        `http://127.0.0.1:${ready.port}`,
      ],
      process.cwd(),
    );
    console.log("Fresh starter and its production build passed.");
  } finally {
    child.kill();
    await child.exited;
  }
} finally {
  await rm(temp, { recursive: true, force: true });
}
