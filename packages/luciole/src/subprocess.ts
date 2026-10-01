/**
 * Runs a command to its end and gives what it wrote. Asynchronous on purpose: Bun 1.4's
 * spawnSync can lose its child's exit (oven-sh/bun#34069), the child staying a zombie
 * while the sync wait spins at 100 % CPU, and every later spawnSync of the process hangs
 * too. Awaited, the exit comes through the event loop.
 */
export type Ran = { exitCode: number; stdout: Uint8Array; stderr: string };
export async function run(
  command: readonly string[],
  options: {
    cwd?: string;
    env?: Record<string, string | undefined>;
    stdin?: Uint8Array | string;
  } = {},
): Promise<Ran> {
  const { stdin } = options;
  const child = Bun.spawn([...command], {
    cwd: options.cwd,
    env: options.env,
    stdin: stdin === undefined ? "ignore" : typeof stdin === "string" ? Buffer.from(stdin) : stdin,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).bytes(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { exitCode, stdout, stderr };
}
export const textOf = (bytes: Uint8Array) => new TextDecoder().decode(bytes);
