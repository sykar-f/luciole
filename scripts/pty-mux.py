#!/usr/bin/env python3
"""Local multiplexer production smoke: built artefacts, separate Server and Client, real PTY.

Journeys: a shell and vim side by side → typing reaches the active pane → Ctrl+C interrupts
the shell's job instead of quitting → the Ctrl+O prefix moves the keys to vim → vim edits
and quits, its pane closes → a new shell pane opens and exits → the window shrinks and the
program sees it → Ctrl+O q quits, the terminal is restored and no pane program survives.
Then mdreader inline next to a shell (<Embed>): keys go to the active pane only, the same
prefix moves them, and Ctrl+C in the application closes its pane, not the multiplexer.
Observes PTY output, not photons.
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

import pyte

ROOT = pathlib.Path(__file__).resolve().parents[1]
APP = ROOT / "examples/mux"
MDREADER = ROOT / "examples/mdreader"
BUN = shutil.which("bun")
VIM = shutil.which("vim")
COLS, ROWS = 120, 30
ENV = {**os.environ, "TERM": "xterm-256color", "NODE_ENV": "production"}
PREFIX = b"\x0f"  # Ctrl+O


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

    def wait_for(self, needle, timeout=15, absent=False):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            if (needle in self.text()) != absent and self.complete_frame():
                return
            self.pump()
        raise AssertionError(f"PTY {'kept' if absent else 'never showed'} {needle!r}\n{self.text()}")

    def settle(self, seconds=0.3):
        end = time.monotonic() + seconds
        while time.monotonic() < end:
            self.pump(0.02)

    def send(self, data, pause=0.15):
        os.write(self.master, data)
        # A lone ESC needs a pause to be told apart from an Alt sequence.
        self.settle(pause)


def start_server(app, env):
    server = subprocess.Popen(
        [BUN, "--conditions=react-server", str(app / ".airtty/server/index.js")],
        env={**ENV, "PORT": "0", **env},
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    )
    return server, "http://127.0.0.1:" + str(json.loads(server.stdout.readline())["port"])


def start_mux(url, directory, env):
    master, slave = pty.openpty()
    fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", ROWS, COLS, 0, 0))
    before = termios.tcgetattr(slave)
    client = subprocess.Popen(
        [BUN, str(APP / ".airtty/client/index.js"), "--url", url],
        stdin=slave,
        stdout=slave,
        stderr=slave,
        env={
            **ENV,
            "XDG_STATE_HOME": directory + "/state",
            "SHELL": "/bin/sh",
            "PS1": "$ ",
            "ENV": "",
            **env,
        },
        start_new_session=True,
    )
    return client, master, slave, before


def quit_mux(t, client, slave, before):
    t.send(PREFIX)
    t.send(b"q")
    deadline = time.monotonic() + 5
    while client.poll() is None and time.monotonic() < deadline:
        t.pump()
    assert client.returncode == 0, client.returncode
    assert termios.tcgetattr(slave) == before, "terminal attributes not restored"


def stop(client, *servers):
    if client and client.poll() is None:
        client.kill()
        client.wait(timeout=5)
    for server in servers:
        if server and server.poll() is None:
            server.terminate()
            server.wait(timeout=5)


def alive(pid):
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    return True


def inline_app():
    """mdreader inline next to a shell: one prefix for both, keys to the active pane only."""
    subprocess.run(
        [BUN, str(ROOT / "src/cli.ts"), "build", "--app", str(MDREADER)],
        check=True,
        stdout=subprocess.DEVNULL,
    )
    mux = docs = client = master = slave = None
    with tempfile.TemporaryDirectory(prefix="mux-inline-pty-") as directory:
        library = pathlib.Path(directory) / "docs"
        library.mkdir()
        (library / "README.md").write_text("# Handbook\n\nalpha-inline\n")
        (library / "guide.md").write_text("# Guide\n\nbeta-inline\n")
        try:
            mux, url = start_server(APP, {})
            docs, docs_url = start_server(MDREADER, {"MD_PATH": str(library)})
            apps = [{"name": "docs", "bundle": str(MDREADER / ".airtty/app"), "url": docs_url}]
            client, master, slave, before = start_mux(
                url,
                directory,
                {"MUX_PANES": json.dumps([["/bin/sh"]]), "MUX_APPS": json.dumps(apps)},
            )
            t = Terminal(master)
            t.wait_for("MUX · pane 0 of 2")
            t.wait_for("docs (airtty)")
            t.wait_for("alpha-inline")
            t.wait_for("$ ")

            # The shell has the keys: `[` is text for it, not mdreader's "previous document".
            t.send(b"printf 'o%sk\\n' '['\r")
            t.wait_for("o[k")
            t.settle(0.4)
            assert "alpha-inline" in t.text(), t.text()

            # The one prefix moves the keys to the application; `[` is now mdreader's.
            t.send(PREFIX)
            t.send(b"o")
            t.wait_for("MUX · pane 1 of 2")
            t.send(b"[")
            t.wait_for("beta-inline")

            # Ctrl+C in the application closes its pane, not the multiplexer.
            t.send(b"\x03")
            t.wait_for("MUX · pane 0 of 1")
            t.wait_for("docs (airtty)", absent=True)
            assert client.poll() is None, "Ctrl+C in the embedded application quit the multiplexer"
            t.send(b"printf 'b%sk\\n' ack\r")
            t.wait_for("backk")
            quit_mux(t, client, slave, before)
        finally:
            stop(client, mux, docs)
            if master is not None:
                os.close(master)
                os.close(slave)


def main():
    subprocess.run(
        [BUN, str(ROOT / "src/cli.ts"), "build", "--app", str(APP)], check=True, stdout=subprocess.DEVNULL
    )
    right = [VIM, "-u", "NONE", "-N"] if VIM else ["/bin/sh"]
    server = client = master = slave = None
    with tempfile.TemporaryDirectory(prefix="mux-pty-") as directory:
        pidfile = pathlib.Path(directory) / "shell.pid"
        try:
            server, url = start_server(APP, {})
            client, master, slave, before = start_mux(
                url, directory, {"MUX_PANES": json.dumps([["/bin/sh"], right])}
            )
            t = Terminal(master)
            t.wait_for("MUX · pane 0 of 2")
            t.wait_for("Ctrl+O then")  # the Server-rendered page
            t.wait_for("$ ")

            # Typing reaches the active pane; the shell records its pid for the last check.
            t.send(f"echo $$ > {pidfile}; printf 'o%sk\\n' K\r".encode())
            t.wait_for("oKk")
            shell_pid = int(pidfile.read_text().strip())

            # Ctrl+C interrupts the shell's foreground job; the multiplexer keeps running.
            t.send(b"sleep 30\r", pause=0.4)
            t.send(b"\x03")
            t.send(b"printf 's%s\\n' $?\r")
            t.wait_for("s130")
            assert client.poll() is None, "Ctrl+C quit the multiplexer"

            # The prefix moves the keys to the other pane.
            t.send(PREFIX)
            t.send(b"o")
            t.wait_for("MUX · pane 1 of 2")
            if VIM:
                t.send(b"ihello-from-vim", pause=0.3)
                t.send(b"\x1b", pause=0.4)
                t.wait_for("hello-from-vim")
                t.send(b":q!\r")
            else:
                t.send(b"exit\r")
            # Its program ended: the pane closes and the shell has the keys again.
            t.wait_for("MUX · pane 0 of 1")

            # A new shell pane, closed by its own exit.
            t.send(PREFIX)
            t.send(b"c")
            t.wait_for("MUX · pane 2 of 2")
            t.send(b"exit\r")
            t.wait_for("MUX · pane 0 of 1")

            # The window shrinks: the program in the pane sees its new size.
            t.send(b"stty size\r")
            t.settle(0.4)
            wide = t.text()
            fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", ROWS - 6, COLS - 30, 0, 0))
            t.screen.resize(ROWS - 6, COLS - 30)
            os.kill(client.pid, signal.SIGWINCH)
            t.settle(0.5)
            t.send(b"clear; stty size\r")
            t.wait_for(f"{ROWS - 6 - 3} {COLS - 30 - 2}")
            assert wide != t.text()

            # Quit through the prefix: the terminal comes back, no pane program survives.
            quit_mux(t, client, slave, before)
            deadline = time.monotonic() + 3
            while alive(shell_pid) and time.monotonic() < deadline:
                time.sleep(0.05)
            assert not alive(shell_pid), f"pane shell {shell_pid} survived the multiplexer"
        finally:
            stop(client, server)
            if master is not None:
                os.close(master)
                os.close(slave)
    inline_app()
    print(
        json.dumps(
            {
                "productionPTY": True,
                "vim": bool(VIM),
                "typingReachesActivePane": True,
                "ctrlCReachesProgram": True,
                "prefixMovesKeys": True,
                "exitedPaneCloses": True,
                "resizeReachesProgram": True,
                "quitRestoresTerminal": True,
                "noSurvivingPaneProgram": True,
                "inlineAirttyPane": True,
                "keysOnlyToActivePane": True,
                "ctrlCClosesAppPaneOnly": True,
            },
            indent=2,
        )
    )


if __name__ == "__main__":
    main()
