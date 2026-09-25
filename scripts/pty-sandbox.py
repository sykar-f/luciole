#!/usr/bin/env python3
"""`airtty http://…` in a real PTY: the application runs sandboxed.

Journey, offline and on private XDG directories: a publisher key, mdreader built with a
signed bundle, its Server on a local port → without a terminal to confirm on, nothing
opens → with --yes the capabilities screen says who enforces what (the Server's port by
the OS, nothing else granted), the key is pinned, the app runs in its own process, which
the kernel reports confined (Seatbelt on macOS; seccomp and no_new_privs on Linux), drawn
by the VT widget, and follows its keys → a second
launch needs no question → Ctrl+C in the app
ends it, which closes its tab and the Client → --allow-read is granted, remembered and
shown as enforced by the OS → --inline switches the origin to inline.
On Linux the mechanism is what this system allows, or AIRTTY_SANDBOX_MECHANISM
(scripts/linux-sandbox.ts runs each); Landlock alone confines no network by host, so it is
never the default: the journey asks for it with --sandbox. Elsewhere: skipped, said so.
"""
import fcntl
import json
import os
import pathlib
import pty
import re
import select
import shutil
import struct
import subprocess
import tempfile
import termios
import time

import ctypes
import pyte
import sys

ROOT = pathlib.Path(__file__).resolve().parents[1]
MDREADER = ROOT / "examples/mdreader"
BUN = shutil.which("bun")
COLS, ROWS = 120, 30


class Terminal:
    def __init__(self, master):
        self.master = master
        self.screen = pyte.Screen(COLS, ROWS)
        self.stream = pyte.ByteStream(self.screen)
        self.raw = b""

    def text(self):
        return "\n".join(self.screen.display)

    def pump(self, timeout=0.05):
        readable, _, _ = select.select([self.master], [], [], timeout)
        if not readable:
            return
        try:
            data = os.read(self.master, 65536)
        except OSError:
            return
        if b"\x1b[6n" in data:
            os.write(self.master, b"\x1b[1;1R")
        if b"\x1b[c" in data:
            os.write(self.master, b"\x1b[?1;2c")
        self.raw += data
        self.stream.feed(data)

    def complete_frame(self):
        return self.raw.rfind(b"\x1b[?2026l") >= self.raw.rfind(b"\x1b[?2026h")

    def wait_for(self, needle, timeout=40):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            if needle in self.text() and self.complete_frame():
                return
            self.pump()
        raise AssertionError(f"PTY never showed {needle!r}\n{self.text()}")

    def send(self, data, pause=0.2):
        os.write(self.master, data)
        end = time.monotonic() + pause
        while time.monotonic() < end:
            self.pump(0.02)


def main():
    if sys.platform not in ("darwin", "linux"):
        print(json.dumps({"skipped": f"no sandbox mode on {sys.platform}"}))
        return
    # What this system allows (src/sandbox/mechanism.ts): nothing → said so, and skipped.
    availability = json.loads(
        subprocess.run(
            [BUN, "-e", "import {sandboxAvailability} from './packages/airtty/src/sandbox/runtime';"
             "console.log(JSON.stringify(sandboxAvailability()))"],
            cwd=ROOT, capture_output=True, text=True, check=True,
        ).stdout
    )
    if not availability.get("mechanism"):
        print(json.dumps({"skipped": f"no sandbox mechanism here: {availability.get('reason')}"}))
        return
    # Landlock alone is never the default for a URL: the user asks for it.
    explicit = ["--sandbox"] if os.environ.get("AIRTTY_SANDBOX_MECHANISM") == "landlock" else []
    with tempfile.TemporaryDirectory(prefix="airtty-pty-sandbox-") as directory:
        base = pathlib.Path(directory)
        env = {
            **os.environ,
            "TERM": "xterm-256color",
            "HOME": str(base / "home"),
            "XDG_CONFIG_HOME": str(base / "config"),
            "XDG_STATE_HOME": str(base / "state"),
            "XDG_CACHE_HOME": str(base / "cache"),
            "XDG_DATA_HOME": str(base / "data"),
        }
        docs = base / "docs"
        docs.mkdir()
        (docs / "README.md").write_text("# Handbook\n\nalpha-sandbox\n")
        (docs / "guide.md").write_text("# Guide\n\nbeta-sandbox\n")
        granted = base / "granted"
        granted.mkdir()

        def airtty(*args, config=None, **kwargs):
            return subprocess.run(
                [BUN, str(ROOT / "packages/airtty/src/cli.ts"), *args],
                env={**env, **({"XDG_CONFIG_HOME": config} if config else {})},
                capture_output=True,
                text=True,
                **kwargs,
            )

        publisher = str(base / "publisher")
        airtty("keys", "generate", config=publisher, check=True)
        fingerprint = re.search(r"SHA256:\S+", airtty("keys", config=publisher, check=True).stdout)
        airtty("build", "--app", str(MDREADER), "--sign-bundle", config=publisher, check=True)
        server = subprocess.Popen(
            [BUN, "--conditions=react-server", str(MDREADER / ".airtty/server/index.js")],
            env={**env, "PORT": "0", "MD_PATH": str(docs)},
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
        )
        port = json.loads(server.stdout.readline())["port"]
        url = f"http://127.0.0.1:{port}"

        def session(*args):
            master, slave = pty.openpty()
            fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", ROWS, COLS, 0, 0))
            before = termios.tcgetattr(slave)
            client = subprocess.Popen(
                [BUN, str(ROOT / "packages/airtty/src/cli.ts"), url, *args],
                cwd=directory,
                stdin=slave,
                stdout=slave,
                stderr=slave,
                env=env,
                start_new_session=True,
            )
            return client, master, slave, before

        def finish(t, client, master, slave, before):
            deadline = time.monotonic() + 10
            while client.poll() is None and time.monotonic() < deadline:
                t.pump()
            assert client.returncode == 0, client.returncode
            assert termios.tcgetattr(slave) == before, "terminal attributes not restored"
            os.close(master)
            os.close(slave)

        def sandboxed_children():
            listed = subprocess.run(["ps", "-axo", "pid=,command="], capture_output=True, text=True)
            return [
                line
                for line in listed.stdout.splitlines()
                if re.match(r"\s*\d+ \S*/bun (--no-install )?\S*/sandbox/\.airtty/child\.js --url ", line)
                and directory in line
            ]

        try:
            # No terminal to confirm on: nothing of the application runs.
            refused = airtty(url, *explicit)
            assert refused.returncode != 0 and "not opened" in refused.stderr, refused.stderr
            assert "Sandbox (" in refused.stderr, refused.stderr

            # Sandboxed by default: the screen, the pinned key, the app in its own process.
            client, master, slave, before = session("--yes", *explicit)
            t = Terminal(master)
            t.wait_for("alpha-sandbox")
            t.wait_for("aucune capacité accordée")
            t.wait_for("sandbox · ")
            t.wait_for(f"mdreader · {url}")
            shown = t.raw.decode("utf-8", "replace")
            assert "Sandbox (" in shown and fingerprint.group(0) in shown, shown[:2000]
            assert f"Server de l'app {url} — " in shown, shown[:2000]
            assert "Capacités accordées : aucune" in shown
            children = sandboxed_children()
            assert len(children) == 1, children
            # The kernel's word: the app's process runs confined.
            child_pid = int(children[0].split()[0])
            if sys.platform == "darwin":
                libsystem = ctypes.CDLL("/usr/lib/libSystem.B.dylib")
                libsystem.sandbox_check.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_int]
                assert libsystem.sandbox_check(child_pid, None, 0) == 1, "the app is not sandboxed"
            else:
                status = pathlib.Path(f"/proc/{child_pid}/status").read_text()
                assert "\nSeccomp:\t2\n" in status, status
                assert "\nNoNewPrivs:\t1\n" in status, status
            t.send(b"[")  # mdreader's key, through the VT widget to the sandboxed Client
            t.wait_for("beta-sandbox")
            # Ctrl+C reaches the app, which quits: its tab closes, then the Client.
            t.send(b"\x03")
            finish(t, client, master, slave, before)
            assert not sandboxed_children(), "the sandboxed Client outlived its tab"

            record = json.loads(
                next((base / "state/airtty/origins").glob("*/origin.json")).read_text()
            )
            assert record["mode"] == "sandbox", record
            assert record["publisher"]["fingerprint"] == fingerprint.group(0), record

            # Remembered: no question; a flag grants more, shown with who enforces it.
            client, master, slave, before = session(f"--allow-read={granted}", *explicit)
            t = Terminal(master)
            t.wait_for("alpha-sandbox")
            t.wait_for("fs.read (OS)")
            shown = t.raw.decode("utf-8", "replace")
            assert f"fs.read {granted} — OS (" in shown, shown[:2000]
            t.send(b"\x0f")
            t.send(b"q")
            finish(t, client, master, slave, before)
            record = json.loads(
                next((base / "state/airtty/origins").glob("*/origin.json")).read_text()
            )
            assert record["granted"]["fs"]["read"] == [str(granted)], record

            # Inline by explicit choice: asked once, then remembered.
            client, master, slave, before = session("--inline", "--yes")
            t = Terminal(master)
            t.wait_for("alpha-sandbox")
            t.wait_for("inline · confiance totale")
            assert not sandboxed_children()
            t.send(b"\x0f")
            t.send(b"q")
            finish(t, client, master, slave, before)
        finally:
            if server.poll() is None:
                server.terminate()
                server.wait(timeout=5)
            # The example keeps an unsigned build, as the repository expects.
            subprocess.run(
                [BUN, str(ROOT / "packages/airtty/src/cli.ts"), "build", "--app", str(MDREADER)],
                env=env,
                stdout=subprocess.DEVNULL,
                check=True,
            )
    print(
        json.dumps(
            {
                "productionPTY": True,
                "refusedWithoutConfirmation": True,
                "sandboxByDefault": True,
                "capabilitiesScreenNamesEnforcers": True,
                "appInSandboxedProcess": True,
                "kernelReportsSandboxed": True,
                "keysThroughVtWidget": True,
                "ctrlCEndsChildAndTab": True,
                "allowFlagRememberedAndShown": True,
                "inlineByExplicitChoice": True,
                "terminalRestored": True,
            },
            indent=2,
        )
    )


if __name__ == "__main__":
    main()
