import { mkdtemp, cp, rm, mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
const temp = await mkdtemp(join(tmpdir(), "terminal-release-"));
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
    "src",
    "examples",
    "package.json",
    "bun.lock",
    "tsconfig.json",
    "types.d.ts",
  ])
    await cp(resolve(name), join(checkout, name), {
      recursive: true,
      filter: (p) =>
        !p.includes(".terminal") &&
        !p.endsWith(".sqlite") &&
        !p.endsWith(".sqlite-shm") &&
        !p.endsWith(".sqlite-wal"),
    });
  await run([process.execPath, "install", "--frozen-lockfile"], checkout);
  await run([process.execPath, "run", "check"], checkout);
  await run(
    [process.execPath, "src/cli.ts", "init", join(temp, "starter")],
    checkout,
  );
  await run(
    [process.execPath, "src/cli.ts", "build", "--app", join(temp, "starter")],
    checkout,
  );
  for (const role of ["client", "server"]) {
    const dest = join(temp, role);
    await cp(join(temp, "starter/.terminal", role), dest, { recursive: true });
    await run([process.execPath, "install", "--frozen-lockfile"], dest);
  }
  const child = Bun.spawn(
    [
      process.execPath,
      "--conditions=react-server",
      join(temp, "server/index.js"),
    ],
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
    const ready = JSON.parse(line.split("\n")[0]);
    await run(
      [
        process.env.PYTHON ?? "python3",
        "scripts/pty-smoke.py",
        "--client",
        join(temp, "client/index.js"),
        "--url",
        `http://127.0.0.1:${ready.port}`,
      ],
      process.cwd(),
    );
    console.log(
      "Fresh starter and independently installed production artefacts passed.",
    );
  } finally {
    child.kill();
    await child.exited;
  }
} finally {
  await rm(temp, { recursive: true, force: true });
}
