/**
 * The sandboxed side: one action per run, one JSON line on stdout. `ok` says whether the
 * operation succeeded; the probe compares it with what the profile should allow. Errors
 * are reported, never thrown, so a denial reads as data and not as a crashed child.
 */
import { spawnSync } from "node:child_process";
import { lookup } from "node:dns/promises";
import { closeSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { connect } from "node:net";

const CONNECT_TIMEOUT_MS = 2000;
const DETAIL_CHARS = 300;
const EXCERPT_CHARS = 20;

const report = (ok: boolean, detail: string) =>
  console.log(JSON.stringify({ ok, detail: detail.trim().slice(0, DETAIL_CHARS) }));
const messageOf = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Runs a binary; `ok` when it started and exited 0. */
function run(file: string, args: string[], input?: string) {
  const result = spawnSync(file, args, { input, encoding: "utf8", timeout: CONNECT_TIMEOUT_MS });
  if (result.error) return report(false, messageOf(result.error));
  report(
    result.status === 0,
    `status=${result.status} out=${result.stdout.trim()} err=${result.stderr.trim()}`,
  );
}

/** Speaks HTTP/1.1 CONNECT to a proxy, then plain HTTP through the tunnel. */
function tunnel(proxy: string, target: string) {
  const [host = "", port = ""] = proxy.split(":");
  const socket = connect({ host, port: Number(port) });
  let received = "";
  let tunnelled = false;
  const timer = setTimeout(() => {
    report(false, `timeout: ${received}`);
    socket.destroy();
  }, CONNECT_TIMEOUT_MS);
  socket.on("connect", () => socket.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`));
  socket.on("data", (chunk: Buffer) => {
    received += chunk.toString();
    if (!tunnelled) {
      if (!received.includes("\r\n\r\n")) return;
      if (!received.startsWith("HTTP/1.1 200")) {
        clearTimeout(timer);
        report(false, received.split("\r\n")[0] ?? received);
        socket.destroy();
        return;
      }
      tunnelled = true;
      received = "";
      socket.write(`GET / HTTP/1.1\r\nHost: ${target}\r\nConnection: close\r\n\r\n`);
    }
  });
  socket.on("end", () => {
    if (!tunnelled) return;
    clearTimeout(timer);
    report(received.startsWith("HTTP/1.1 200"), received.split("\r\n\r\n").at(-1) ?? "");
  });
  socket.on("error", (e) => {
    clearTimeout(timer);
    report(false, messageOf(e));
  });
}

const [action = "", ...args] = process.argv.slice(2);
const first = args[0] ?? "";
try {
  switch (action) {
    case "noop":
      report(true, "");
      break;
    case "boot": {
      // What an airtty Client loads before rendering: React and OpenTUI's native library.
      const { createTestRenderer } = await import("@opentui/core/testing");
      const react = await import("react");
      const { renderer } = await createTestRenderer({ width: 10, height: 2 });
      renderer.destroy();
      report(true, `react ${react.version}`);
      break;
    }
    case "tz":
      // Without the zoneinfo rule Bun silently falls back to UTC.
      report(true, Intl.DateTimeFormat().resolvedOptions().timeZone);
      break;
    case "read":
      report(true, readFileSync(first, "utf8").slice(0, EXCERPT_CHARS));
      break;
    case "write":
      writeFileSync(first, "written by the sandboxed child\n");
      report(true, first);
      break;
    case "exec":
      run(first, args.slice(1));
      break;
    case "pty": {
      // Opening the multiplexer device allocates a pseudo-terminal pair (posix_openpt).
      const fd = openSync("/dev/ptmx", "r+");
      closeSync(fd);
      report(true, "opened /dev/ptmx");
      break;
    }
    case "fetch": {
      const [url = "", proxy] = args;
      const response = await fetch(url, {
        proxy,
        signal: AbortSignal.timeout(CONNECT_TIMEOUT_MS),
      });
      report(response.ok, `${response.status} ${await response.text()}`);
      break;
    }
    case "tcp": {
      // A raw connection ignores HTTP_PROXY: it tests what the OS lets through.
      const [host = "", port = ""] = first.split(":");
      const socket = connect({ host, port: Number(port) });
      const timer = setTimeout(() => {
        report(false, "timeout");
        socket.destroy();
      }, CONNECT_TIMEOUT_MS);
      socket.on("connect", () => {
        clearTimeout(timer);
        report(true, "connected");
        socket.destroy();
      });
      socket.on("error", (e) => {
        clearTimeout(timer);
        report(false, messageOf(e));
      });
      break;
    }
    case "connect":
      tunnel(first, args[1] ?? "");
      break;
    case "dns": {
      const address = await lookup(first);
      report(true, address.address);
      break;
    }
    default:
      report(false, `unknown action ${action}`);
  }
} catch (e) {
  report(false, messageOf(e));
}
