#!/usr/bin/env python3
"""Forge production smoke: built artefacts, separate Server and Client processes, real PTY.

Journey: sign in → repository → pull request → approve → comment → files → $EDITOR
→ live checks → merge → quit. Runs under simulated latency (AIRTTY_LATENCY_MS, default 500)
and measures that typing stays local. Observes PTY output, not photons.
"""
import fcntl
import json
import os
import pathlib
import pty
import select
import shutil
import struct
import subprocess
import tempfile
import termios
import time

import pyte

ROOT = pathlib.Path(__file__).resolve().parents[1]
APP = ROOT / "examples/forge"
BUN = shutil.which("bun")
COLS, ROWS = 140, 40
LATENCY_MS = int(os.environ.get("AIRTTY_LATENCY_MS", "500"))
# 22 days after the seed's epoch (server/seed.ts, 2026-09-01T09:00Z): the Server's clock
# starts there, so the ages in docs/forge-pty-frame.txt do not change with the day of the run.
CLOCK_START = "2026-09-23T09:00:00Z"
ENV = {**os.environ, "TERM": "xterm-256color", "NODE_ENV": "production"}


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
        # Answer the cursor and device queries OpenTUI sends at startup.
        if b"\x1b[6n" in data:
            os.write(self.master, b"\x1b[1;1R")
        if b"\x1b[c" in data:
            os.write(self.master, b"\x1b[?1;2c")
        self.raw += data
        self.stream.feed(data)

    def complete_frame(self):
        # Synchronized output: wait for the end of the last frame update.
        return self.raw.rfind(b"\x1b[?2026l") >= self.raw.rfind(b"\x1b[?2026h")

    def wait_for(self, needle, timeout=15):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            if needle in self.text() and self.complete_frame():
                return time.monotonic()
            self.pump()
        raise AssertionError(f"PTY never showed {needle!r}\n{self.text()}")

    def send(self, data, pause=0.12):
        os.write(self.master, data)
        # A lone ESC needs a pause to be told apart from an Alt sequence.
        end = time.monotonic() + pause
        while time.monotonic() < end:
            self.pump(0.02)


def main():
    subprocess.run([BUN, str(ROOT / "src/cli.ts"), "build", "--app", str(APP)], check=True, stdout=subprocess.DEVNULL)
    with tempfile.TemporaryDirectory(prefix="forge-pty-") as directory:
        server = client = master = slave = None
        try:
            server = subprocess.Popen(
                [BUN, "--conditions=react-server", str(APP / ".airtty/server/index.js")],
                env={**ENV, "PORT": "0", "FORGE_DB": directory + "/forge.sqlite", "FORGE_SLOW_MS": "150", "FORGE_CI_SCALE": "0.2", "FORGE_CLOCK_START": CLOCK_START},
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
            )
            ready = json.loads(server.stdout.readline())
            url = f"http://127.0.0.1:{ready['port']}"
            # A stand-in for $EDITOR: it draws on the terminal Forge hands over, reads what the
            # user types there, and records it with the process that started it.
            editor = pathlib.Path(directory) / "fake-editor"
            marker = pathlib.Path(directory) / "editor-marker"
            editor.write_text(
                "#!/bin/sh\n"
                "for last; do :; done\n"
                'printf "FAKE EDITOR %s\\n" "$(basename "$last")"\n'
                "IFS= read -r typed\n"
                f'echo "$PPID $typed" > "{marker}"\n'
            )
            editor.chmod(0o755)
            master, slave = pty.openpty()
            fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", ROWS, COLS, 0, 0))
            before = termios.tcgetattr(slave)
            client = subprocess.Popen(
                [BUN, str(APP / ".airtty/client/index.js"), "--url", url],
                stdin=slave, stdout=slave, stderr=slave, start_new_session=True,
                env={**ENV, "VISUAL": "", "EDITOR": str(editor), "XDG_STATE_HOME": directory + "/state"},
            )
            term = Terminal(master)
            results = {"productionPTY": True, "simulatedRTTMs": LATENCY_MS}

            term.wait_for("Demo accounts")
            term.send(b"alice\r")
            term.send(b"forge\r")
            term.wait_for("@alice · maintainer")
            term.wait_for("RECENT ACTIVITY")

            term.send(b"1")
            term.wait_for("open pull request(s)")
            term.send(b"/")
            term.send(b"idempotency")
            term.send(b"\x1b", pause=0.3)
            start = time.monotonic()
            term.send(b"\r", pause=0)
            term.wait_for("[m] merge")
            results["openPullRequestMs"] = round((time.monotonic() - start) * 1000)

            term.send(b"a")
            term.wait_for("Approvals: @alice")
            term.send(b"c")
            start = time.monotonic()
            term.send(b"S", pause=0)
            shown = term.wait_for("Unsaved Draft", timeout=5)
            results["typingToPTYOutputMs"] = round((shown - start) * 1000)
            assert results["typingToPTYOutputMs"] < LATENCY_MS, results
            term.send(b"hip it")
            term.send(b"\x13")  # Ctrl+S publishes; typing continues meanwhile
            term.wait_for("Ship it")
            term.send(b"\x1b", pause=0.3)

            term.send(b"\t")
            term.wait_for("src/ledger.ts")
            term.send(b"]")
            term.send(b"]")
            term.wait_for("src/refunds.ts · typescript")
            # e: the renderer hands the terminal to the editor, then takes it back.
            term.send(b"e")
            term.wait_for("FAKE EDITOR refunds@r1")
            # Keys that are Forge commands (i inbox, e editor) go to the editor, not to Forge.
            term.send(b"i typed in the editor\r")
            term.wait_for("Viewed refunds@r1")
            assert marker.read_text().strip() == f"{client.pid} i typed in the editor", marker.read_text()
            results["editorOnClient"] = True
            term.send(b"\t")
            term.wait_for("log complete")
            term.send(b"\t")
            term.wait_for("Ready to merge")
            term.send(b"m")
            term.wait_for("Merged #1 into main")
            term.wait_for("Merged by @alice")
            (ROOT / "docs/forge-pty-frame.txt").write_text(
                "\n".join(line.rstrip() for line in term.screen.display).rstrip() + "\n"
            )

            os.write(master, b"\x03")
            deadline = time.monotonic() + 5
            while client.poll() is None and time.monotonic() < deadline:
                term.pump()
            client.wait(timeout=1)
            assert client.returncode == 0, client.returncode
            assert termios.tcgetattr(slave) == before, "terminal attributes not restored"
            results.update({"journey": "login → approve → comment → files → editor → checks → merge", "terminalRestored": True})
            print(json.dumps(results, indent=2))
        finally:
            if client and client.poll() is None:
                client.kill()
                client.wait(timeout=5)
            if server and server.poll() is None:
                server.terminate()
                server.wait(timeout=5)
            if master is not None:
                os.close(master)
                os.close(slave)


if __name__ == "__main__":
    main()
