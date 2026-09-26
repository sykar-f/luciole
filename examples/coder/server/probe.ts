/** Runs a harness's own commands for detection: `--version`, `auth status`, `jq`. */
// A harness that does not answer `--version` in this time is reported, not awaited.
const PROBE_TIMEOUT_MS = 10_000;

/** Runs a harness's own command; its output, or `undefined` when it failed or hung. */
export async function probe(argv: readonly string[], env: NodeJS.ProcessEnv) {
  try {
    const child = Bun.spawn([...argv], { env, stdout: "pipe", stderr: "pipe", stdin: "ignore" });
    const timer = setTimeout(() => child.kill(), PROBE_TIMEOUT_MS);
    const [stdout, code] = await Promise.all([new Response(child.stdout).text(), child.exited]);
    clearTimeout(timer);
    return { stdout, code };
  } catch {
    return undefined;
  }
}
