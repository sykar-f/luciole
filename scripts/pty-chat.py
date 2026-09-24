#!/usr/bin/env python3
"""Chat journey in a real PTY, through `airtty dev`, against a local fake OpenRouter.

Journey: missing key message → streamed reply (Markdown, usage, cost) → history sent back
→ Esc stops a reply and aborts the upstream request → Ctrl+G retries → mid-stream error
→ Ctrl+N new conversation → Ctrl+Down back → quit. No key and no network needed.
"""
import fcntl
import json
import os
import pathlib
import pty
import select
import shutil
import signal
import struct
import subprocess
import tempfile
import termios
import time
import urllib.request

import pyte

ROOT = pathlib.Path(__file__).resolve().parents[1]
APP = ROOT / "examples/chat"
BUN = shutil.which("bun")
COLS, ROWS = 140, 40


class Terminal:
    def __init__(self, master):
        self.master = master
        self.screen = pyte.Screen(COLS, ROWS)
        self.stream = pyte.ByteStream(self.screen)
        self.raw = b""

    def text(self):
        return "\n".join(self.screen.display)

    def pump(self, timeout=0.03):
        if not select.select([self.master], [], [], timeout)[0]:
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

    def wait_for(self, needle, timeout=30):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            if needle in self.text() and self.complete_frame():
                return time.monotonic()
            self.pump()
        raise AssertionError(f"PTY never showed {needle!r}\n{self.text()}")

    def wait_idle(self, timeout=30):
        """Until no reply is streaming: the composer is back to its normal title."""
        return self.wait_for("─ message ─", timeout)

    def send(self, data, pause=0.15):
        os.write(self.master, data)
        end = time.monotonic() + pause
        while time.monotonic() < end:
            self.pump(0.02)


def launch(env, directory):
    master, slave = pty.openpty()
    fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", ROWS, COLS, 0, 0))
    before = termios.tcgetattr(slave)
    dev = subprocess.Popen(
        [BUN, str(ROOT / "src/cli.ts"), "dev", "--app", str(APP)],
        stdin=slave, stdout=slave, stderr=slave, start_new_session=True,
        env={**env, "TERM": "xterm-256color", "XDG_STATE_HOME": directory + "/state"},
    )
    return dev, master, slave, before


def quit(dev, term, slave, before):
    os.write(term.master, b"\x03")
    deadline = time.monotonic() + 5
    while dev.poll() is None and time.monotonic() < deadline:
        term.pump()
    dev.wait(timeout=1)
    assert dev.returncode == 0, dev.returncode
    assert termios.tcgetattr(slave) == before, "terminal attributes not restored"


def main():
    base = {k: v for k, v in os.environ.items() if not k.startswith("OPENROUTER_")}
    results = {}
    fake = subprocess.Popen(
        [BUN, str(APP / "scripts/fake-openrouter.ts")],
        env={**base, "FAKE_DELAY_MS": "60"}, stdout=subprocess.PIPE, text=True,
    )
    port = json.loads(fake.stdout.readline())["port"]
    endpoint = f"http://127.0.0.1:{port}/api/v1"
    stats = lambda: json.load(urllib.request.urlopen(f"http://127.0.0.1:{port}/__stats"))
    with tempfile.TemporaryDirectory(prefix="chat-pty-") as directory:
        dev = master = slave = None
        try:
            # 1. No key: a clear message, and Enter sends nothing.
            dev, master, slave, before = launch({**base, "OPENROUTER_BASE_URL": endpoint}, directory)
            term = Terminal(master)
            term.wait_for("OPENROUTER_API_KEY is not set on the Server.")
            term.wait_for("$0.10/M in · $0.50/M out")
            term.send(b"hi\r")
            term.wait_for("export it and restart")
            assert stats()["requests"] == 0, stats()
            results["missingKeyMessage"] = True
            quit(dev, term, slave, before)
            os.close(master), os.close(slave)
            master = slave = None

            # 2. With a key: the full journey.
            env = {**base, "OPENROUTER_BASE_URL": endpoint, "OPENROUTER_API_KEY": "sk-or-fake"}
            dev, master, slave, before = launch(env, directory)
            term = Terminal(master)
            term.wait_for("Ask anything")
            # Ctrl+J adds a line; Enter sends both.
            term.send(b"hello world\nsecond line")
            term.wait_for("second line")
            start = time.monotonic()
            term.send(b"\r", pause=0)
            term.wait_for("streaming…")
            results["firstTokenOnScreenMs"] = round((time.monotonic() - start) * 1000)
            term.wait_for("Done.")
            term.wait_idle()
            shown = term.text()
            assert "You said: hello world" in shown, shown  # Markdown bold, markers hidden
            assert "**" not in shown and "```" not in shown, shown
            assert "turns received: 1" in shown and "in ·" in shown and "out" in shown, shown
            assert stats()["histories"][-1] == [{"role": "user", "content": "hello world\nsecond line"}]
            results["streamedMarkdownReply"] = True

            term.send(b"again\r")
            term.wait_for("turns received: 3")
            term.wait_idle()
            assert [m["role"] for m in stats()["histories"][-1]] == ["user", "assistant", "user"]
            results["historySent"] = True

            # Esc stops a reply: partial text stays, the upstream stream is aborted.
            aborted = stats()["aborted"]
            term.send(b"stop me\r", pause=0)
            term.wait_for("streaming…")
            term.send(b"\x1b", pause=0.3)
            term.wait_for("stopped · Ctrl+G retry")
            deadline = time.monotonic() + 5
            while stats()["aborted"] == aborted:
                assert time.monotonic() < deadline, stats()
                term.pump(0.1)
            results["escAbortsUpstream"] = True
            term.send(b"\x07")  # Ctrl+G
            term.wait_for("You said: stop me")
            term.wait_for("turns received: 5")
            term.wait_idle()
            results["retry"] = True

            term.send(b"please fail\r")
            term.wait_for("✗ Upstream provider disconnected")
            results["midStreamError"] = True

            term.send(b"\x0e")  # Ctrl+N
            term.wait_for("Ask anything")
            term.wait_for("New conversation")
            term.send(b"\x1b[1;5B")  # Ctrl+Down: the older conversation
            term.wait_for("You said: please fail")
            results["conversations"] = True
            (ROOT / "examples/chat/pty-frame.txt").write_text(
                "\n".join(line.rstrip() for line in term.screen.display).rstrip() + "\n"
            )
            quit(dev, term, slave, before)
            results["terminalRestored"] = True
            print(json.dumps(results, indent=2))
        finally:
            if dev and dev.poll() is None:
                os.killpg(dev.pid, signal.SIGKILL)
                dev.wait()
            if master is not None:
                os.close(master)
                os.close(slave)
            fake.terminate()
            fake.wait(timeout=5)


if __name__ == "__main__":
    main()
