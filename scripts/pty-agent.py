#!/usr/bin/env python3
"""Agent example in a real PTY, against the real pi and model (spends a little quota).

Journey: `airtty dev` → pi boots → prompt with write + bash tool calls streamed → the
file exists in the sandbox → browse and unfold the calls → a long bash call interrupted
with Ctrl+X → new session → quit, with no pi process left behind. Sandbox and state
live in a temporary directory. AGENT_MODEL / AGENT_THINKING pass through.
"""
import fcntl
import json
import os
import pathlib
import pty
import re
import select
import shutil
import signal
import struct
import subprocess
import tempfile
import termios
import time

import pyte

ROOT = pathlib.Path(__file__).resolve().parents[1]
BUN = shutil.which("bun")
COLS, ROWS = 120, 40
FRAMES = os.environ.get("AGENT_PTY_FRAMES")


class Terminal:
    def __init__(self, master):
        self.master = master
        self.screen = pyte.Screen(COLS, ROWS)
        self.stream = pyte.ByteStream(self.screen)
        self.raw = b""

    def text(self):
        return "\n".join(self.screen.display)

    def pump(self, timeout=0.05):
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

    def wait(self, needle, timeout=30, absent=False):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            self.pump()
            complete = self.raw.rfind(b"\x1b[?2026l") >= self.raw.rfind(b"\x1b[?2026h")
            if complete and ((needle in self.text()) != absent):
                return
        raise AssertionError(f"{'still' if absent else 'missing'} {needle!r}\n{self.text()}")

    def wait_re(self, pattern, timeout=30):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            self.pump()
            if re.search(pattern, self.text()):
                return
        raise AssertionError(f"missing /{pattern}/\n{self.text()}")

    def send(self, data, settle=0.3):
        os.write(self.master, data)
        end = time.monotonic() + settle
        while time.monotonic() < end:
            self.pump()

    def frame(self, name):
        if FRAMES:
            path = pathlib.Path(FRAMES) / f"{name}.txt"
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text("\n".join(line.rstrip() for line in self.screen.display) + "\n")


def pi_processes(cwd):
    # pi renames its process to "pi" (argv is hidden): find it by working directory.
    out = subprocess.run(["pgrep", "-x", "pi"], capture_output=True, text=True).stdout
    found = []
    for pid in out.split():
        lsof = subprocess.run(["lsof", "-a", "-p", pid, "-d", "cwd", "-Fn"],
                              capture_output=True, text=True).stdout
        if f"n{os.path.realpath(cwd)}" in lsof.split("\n"):
            found.append(int(pid))
    return found


with tempfile.TemporaryDirectory(prefix="airtty-agent-") as directory:
    sandbox = pathlib.Path(directory) / "sandbox"
    state = pathlib.Path(directory) / "state"
    master, slave = pty.openpty()
    fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", ROWS, COLS, 0, 0))
    before = termios.tcgetattr(slave)
    env = {
        **os.environ,
        "TERM": "xterm-256color",
        "AGENT_CWD": str(sandbox),
        "XDG_STATE_HOME": str(state),
    }
    dev = subprocess.Popen(
        [BUN, str(ROOT / "src/cli.ts"), "dev", "--app", str(ROOT / "examples/agent")],
        stdin=slave, stdout=slave, stderr=slave, env=env, start_new_session=True,
    )
    term = Terminal(master)
    timings = {}
    try:
        term.wait("No messages yet", timeout=60)
        term.wait("● idle", timeout=30)
        assert str(sandbox) in term.text(), "the working directory is shown"
        assert pi_processes(sandbox), "pi runs"
        term.frame("1-idle")

        start = time.monotonic()
        term.send(b"Create notes.txt containing the word airtty, then run `wc -c notes.txt` "
                  b"with bash. Reply in one short sentence.")
        term.send(b"\r")
        term.wait("running", timeout=15)
        term.wait("✎ write", timeout=90)
        term.wait("$ bash", timeout=90)
        term.wait("● idle", timeout=90)
        timings["firstPromptSeconds"] = round(time.monotonic() - start, 1)
        assert (sandbox / "notes.txt").read_text().strip() == "airtty", "the tool ran in the sandbox"
        assert "wc -c notes.txt" in term.text()
        term.frame("2-answered")

        # Browse: Esc selects the last call (bash); Enter unfolds its output.
        term.send(b"\x1b")
        term.wait("fold all")
        term.send(b"\r")
        term.wait("▾ $ bash")
        assert re.search(r"│\s+\d+ notes\.txt", term.text()), "the bash output is unfolded"
        term.send(b"a", settle=0.5)
        term.wait("+ airtty")
        term.frame("3-unfolded")
        term.send(b"a")
        term.wait("+ airtty", absent=True)
        term.send(b"i")
        term.wait("browse tools")

        # Interrupt a long call; the transcript records it and pi settles.
        term.send(b"Run `sleep 30` with bash, then say done.")
        term.send(b"\r")
        # The call itself is running (its header, with a clock), not just the model.
        term.wait_re(r"\$ bash sleep 30 +running \d", timeout=90)
        term.frame("4-running")
        start = time.monotonic()
        term.send(b"\x18")
        term.wait("Interrupted", timeout=30)
        term.wait("● idle", timeout=30)
        timings["interruptSeconds"] = round(time.monotonic() - start, 1)
        term.frame("5-interrupted")

        # New session: asks for confirmation, then empties the transcript.
        term.send(b"\x0e")
        term.wait("Ctrl+N again")
        term.send(b"\x0e")
        term.wait("No messages yet", timeout=30)
        term.frame("6-new-session")

        term.send(b"\x03")
        deadline = time.monotonic() + 10
        while dev.poll() is None and time.monotonic() < deadline:
            term.pump()
        assert dev.wait(timeout=1) == 0, dev.returncode
        assert termios.tcgetattr(slave) == before, "terminal attributes not restored"
        deadline = time.monotonic() + 5
        while pi_processes(sandbox) and time.monotonic() < deadline:
            time.sleep(0.1)
        assert not pi_processes(sandbox), "pi outlived the Server"
        print(json.dumps({
            "agentPTY": True,
            "toolCallsStreamed": ["write", "bash"],
            "fileWrittenInSandbox": True,
            "unfoldedOutput": True,
            "interrupted": True,
            "newSession": True,
            "terminalRestored": True,
            "noOrphanPi": True,
            **timings,
        }, indent=2))
    finally:
        if dev.poll() is None:
            os.killpg(dev.pid, signal.SIGKILL)
            dev.wait()
        for pid in pi_processes(sandbox):
            os.kill(pid, signal.SIGKILL)
        os.close(master)
        os.close(slave)
