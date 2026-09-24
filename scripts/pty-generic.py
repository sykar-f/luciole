#!/usr/bin/env python3
"""`airtty http://…` in a real PTY: the generic Client opens an application from its Server.

Journey, offline and on private XDG directories: a publisher key, mdreader built with a
signed bundle, its Server on a fixed local port → without --inline nothing opens → with
--inline the warning and the declared capabilities are shown, the key is pinned, the app
runs in a tab and follows its keys → a second launch needs no flag nor question → Ctrl+C
in the app closes its tab and the Client → a new publisher key is refused with the
`airtty trust` command to accept it → after `airtty trust` it opens again.
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

import pyte

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
    with tempfile.TemporaryDirectory(prefix="airtty-pty-generic-") as directory:
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
        (docs / "README.md").write_text("# Handbook\n\nalpha-generic\n")
        (docs / "guide.md").write_text("# Guide\n\nbeta-generic\n")

        def airtty(*args, config=None, **kwargs):
            return subprocess.run(
                [BUN, str(ROOT / "src/cli.ts"), *args],
                env={**env, **({"XDG_CONFIG_HOME": config} if config else {})},
                capture_output=True,
                text=True,
                **kwargs,
            )

        def publish(config):
            airtty("keys", "generate", config=config, check=True)
            fingerprint = re.search(r"SHA256:\S+", airtty("keys", config=config, check=True).stdout)
            airtty("build", "--app", str(MDREADER), "--sign-bundle", config=config, check=True)
            return fingerprint.group(0)

        key_a = publish(str(base / "publisher-a"))
        port = None
        server = None

        def start_server():
            nonlocal server, port
            server = subprocess.Popen(
                [BUN, "--conditions=react-server", str(MDREADER / ".airtty/server/index.js")],
                env={**env, "PORT": str(port or 0), "MD_PATH": str(docs)},
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
            )
            port = json.loads(server.stdout.readline())["port"]

        def stop_server():
            if server and server.poll() is None:
                server.terminate()
                server.wait(timeout=5)

        def session(*args):
            master, slave = pty.openpty()
            fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", ROWS, COLS, 0, 0))
            before = termios.tcgetattr(slave)
            client = subprocess.Popen(
                [BUN, str(ROOT / "src/cli.ts"), url, *args],
                cwd=directory,
                stdin=slave,
                stdout=slave,
                stderr=slave,
                env=env,
                start_new_session=True,
            )
            return client, master, slave, before

        def finish(t, client, slave, before):
            deadline = time.monotonic() + 10
            while client.poll() is None and time.monotonic() < deadline:
                t.pump()
            assert client.returncode == 0, client.returncode
            assert termios.tcgetattr(slave) == before, "terminal attributes not restored"

        try:
            start_server()
            url = f"http://127.0.0.1:{port}"

            # Without --inline nothing of the application runs: refused where the sandbox
            # does not exist, offered sandboxed on macOS, where no terminal confirms it here.
            refused = subprocess.run(
                [BUN, str(ROOT / "src/cli.ts"), url], env=env, capture_output=True, text=True
            )
            assert refused.returncode != 0, refused.stderr
            assert "--inline" in refused.stderr or "not opened" in refused.stderr, refused.stderr

            # First use: the warning, the capabilities, the pinned key; the app in a tab.
            client, master, slave, before = session("--inline", "--yes")
            t = Terminal(master)
            t.wait_for("alpha-generic")
            t.wait_for("inline · confiance totale")
            t.wait_for(f"mdreader · {url}")
            shown = t.raw.decode("utf-8", "replace")
            assert "Confiance totale" in shown and key_a in shown, shown[:2000]
            assert "Capacités déclarées (non appliquées)" in shown
            t.send(b"[")  # mdreader's key: the previous document
            t.wait_for("beta-generic")
            t.send(b"\x0f")
            t.send(b"q")
            finish(t, client, slave, before)
            os.close(master)
            os.close(slave)

            # Remembered: no flag, no question; Ctrl+C in the app closes its tab, then all.
            client, master, slave, before = session()
            t = Terminal(master)
            t.wait_for("alpha-generic")
            t.send(b"\x03")
            finish(t, client, slave, before)
            os.close(master)
            os.close(slave)

            # A new publisher key for the same origin: refused, with the command to accept it.
            stop_server()
            key_b = publish(str(base / "publisher-b"))
            start_server()
            changed = subprocess.run(
                [BUN, str(ROOT / "src/cli.ts"), url], env=env, capture_output=True, text=True
            )
            assert changed.returncode != 0, changed
            assert "publisher key changed" in changed.stderr, changed.stderr
            assert f"airtty trust {url} {key_b}" in changed.stderr, changed.stderr

            # Accepted out of band: it opens again.
            airtty("trust", url, key_b, check=True)
            client, master, slave, before = session()
            t = Terminal(master)
            t.wait_for("alpha-generic")
            t.send(b"\x0f")
            t.send(b"q")
            finish(t, client, slave, before)
            os.close(master)
            os.close(slave)
        finally:
            stop_server()
            # The example keeps an unsigned build, as the repository expects.
            subprocess.run(
                [BUN, str(ROOT / "src/cli.ts"), "build", "--app", str(MDREADER)],
                env=env,
                stdout=subprocess.DEVNULL,
                check=True,
            )
    print(
        json.dumps(
            {
                "productionPTY": True,
                "refusedWithoutInline": True,
                "warningAndCapabilitiesShown": True,
                "firstUsePinned": True,
                "appInTab": True,
                "rememberedWithoutFlag": True,
                "ctrlCClosesTab": True,
                "changedKeyRefusedWithTrustCommand": True,
                "trustCommandAccepts": True,
                "terminalRestored": True,
            },
            indent=2,
        )
    )


if __name__ == "__main__":
    main()
