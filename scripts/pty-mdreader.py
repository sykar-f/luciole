#!/usr/bin/env python3
"""Markdown reader production smoke: built artefacts, separate Server and Client, real PTY.

Journey on a temporary library: home document (README) rendered → next document → find
by name → scroll to the end → outline and jump to a heading → the file changes on disk
and the open document reloads in place → ignored directories stay out → quit.
Observes PTY output, not photons. MDREADER_PTY_FRAMES=<dir> writes each screen there.
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
APP = ROOT / "examples/mdreader"
BUN = shutil.which("bun")
COLS, ROWS = 130, 36
ENV = {**os.environ, "TERM": "xterm-256color", "NODE_ENV": "production"}
FRAMES = os.environ.get("MDREADER_PTY_FRAMES")

README = """# Handbook

Welcome to the **handbook**. It has *emphasis*, `inline code`, ~~old text~~ and a
[link to the project](https://example.com/project).

> A quotation, rendered with a bar on its left.

## Install

1. Clone the repository
2. Run the command below

```ts
const answer: number = 42;
export function greet(name: string) {
  return `hello ${name}`;
}
```

## Reference

| Key | Action |
| --- | ------ |
| j   | down   |
| k   | up     |

- [x] rendered task
- [ ] pending task
"""


def long_guide():
    parts = ["# Guide\n\nThe long document of the library.\n"]
    for section in range(1, 7):
        parts.append(f"\n## Chapter {section}\n")
        for paragraph in range(4):
            parts.append(
                f"\nParagraph {section}.{paragraph}: "
                + "words that wrap across the reading width of the terminal. " * 4
                + "\n"
            )
    parts.append("\n## Appendix\n\nLast words of the guide.\n")
    return "".join(parts)


def library(directory):
    docs = pathlib.Path(directory) / "library"
    (docs / "notes/deep").mkdir(parents=True)
    (docs / "node_modules/pkg").mkdir(parents=True)
    (docs / ".git").mkdir()
    (docs / "README.md").write_text(README)
    (docs / "guide.md").write_text(long_guide())
    (docs / "notes/alpha.md").write_text("# Alpha\n\nFirst note.\n")
    (docs / "notes/deep/beta note.md").write_text("# Beta\n\nA name with a space.\n")
    (docs / "node_modules/pkg/HIDDEN-DEP.md").write_text("# must not be listed\n")
    (docs / ".git/HIDDEN-GIT.md").write_text("# must not be listed\n")
    (docs / "notes/skip.txt").write_text("not markdown\n")
    return docs


class Terminal:
    def __init__(self, master):
        self.master = master
        self.screen = pyte.Screen(COLS, ROWS)
        self.stream = pyte.ByteStream(self.screen)
        self.raw = b""
        self.frame = 0

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
                return time.monotonic()
            self.pump()
        raise AssertionError(f"PTY {'kept' if absent else 'never showed'} {needle!r}\n{self.text()}")

    def settle(self, seconds=0.4):
        end = time.monotonic() + seconds
        while time.monotonic() < end:
            self.pump(0.02)

    def send(self, data, pause=0.15):
        os.write(self.master, data)
        # A lone ESC needs a pause to be told apart from an Alt sequence.
        self.settle(pause)

    def row(self, needle):
        return next(i for i, line in enumerate(self.screen.display) if needle in line)

    def snapshot(self, name):
        if not FRAMES:
            return
        self.frame += 1
        path = pathlib.Path(FRAMES) / f"{self.frame:02d}-{name}.txt"
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text("\n".join(line.rstrip() for line in self.screen.display).rstrip() + "\n")


class Session:
    """A built Server on MD_PATH and a Client in a fresh PTY; quits and checks the terminal."""

    def __init__(self, md_path, state):
        self.md_path, self.state = md_path, state
        self.server = self.client = self.master = self.slave = None

    def __enter__(self):
        self.server = subprocess.Popen(
            [BUN, "--conditions=react-server", str(APP / ".airtty/server/index.js")],
            env={**ENV, "PORT": "0", "MD_PATH": str(self.md_path)},
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
        )
        url = "http://127.0.0.1:" + str(json.loads(self.server.stdout.readline())["port"])
        self.master, self.slave = pty.openpty()
        fcntl.ioctl(self.slave, termios.TIOCSWINSZ, struct.pack("HHHH", ROWS, COLS, 0, 0))
        self.before = termios.tcgetattr(self.slave)
        self.client = subprocess.Popen(
            [BUN, str(APP / ".airtty/client/index.js"), "--url", url],
            stdin=self.slave,
            stdout=self.slave,
            stderr=self.slave,
            # A private state directory: the session file never reaches $HOME.
            env={**ENV, "XDG_STATE_HOME": self.state},
            start_new_session=True,
        )
        return Terminal(self.master)

    def quit(self, t):
        t.send(b"\x03")
        deadline = time.monotonic() + 5
        while self.client.poll() is None and time.monotonic() < deadline:
            t.pump()
        self.client.wait(timeout=1)
        assert self.client.returncode == 0, self.client.returncode
        assert termios.tcgetattr(self.slave) == self.before, "terminal attributes not restored"

    def __exit__(self, *_):
        if self.client and self.client.poll() is None:
            self.client.kill()
            self.client.wait(timeout=5)
        if self.server and self.server.poll() is None:
            self.server.terminate()
            self.server.wait(timeout=5)
        if self.master is not None:
            os.close(self.master)
            os.close(self.slave)


def main():
    subprocess.run(
        [BUN, str(ROOT / "packages/airtty/src/cli.ts"), "build", "--app", str(APP)], check=True, stdout=subprocess.DEVNULL
    )
    with tempfile.TemporaryDirectory(prefix="mdreader-pty-") as directory:
        docs = library(directory)
        session = Session(docs, directory + "/state")
        with session as t:
            # Home: README rendered, markers concealed, list without ignored directories.
            t.wait_for("README.md")
            t.wait_for("Handbook")
            t.wait_for("hello ${name}")
            t.settle(0.8)
            t.snapshot("home")
            shown = t.text()
            assert "# Handbook" not in shown, "heading marker not concealed"
            assert "**handbook**" not in shown, "emphasis markers not concealed"
            assert "4 documents" in shown, shown
            for listed in ["guide.md", "alpha.md", "beta note.md", "▾ notes/", "▾ deep/"]:
                assert listed in shown, listed
            for hidden in ["HIDDEN", "skip.txt"]:
                assert hidden not in shown, hidden
            assert "│j  │down" in shown, "table not rendered"
            # The list has the keys at start: the open document is its bright selection.
            line = next(i for i, text in enumerate(t.screen.display) if text.startswith(" │ README.md"))
            column = t.screen.display[line].index("README.md")
            assert t.screen.buffer[line][column].bg == "1f3b4d", t.screen.buffer[line][column]

            # Browsing the list: the arrows select, the selected document opens.
            t.send(b"\x1b[B")
            t.wait_for("First note.")
            t.send(b"k")
            t.wait_for("Welcome to the")
            # Tab gives the keys to the document: the arrows no longer change it.
            t.send(b"\t")
            t.wait_for("tab files")
            t.send(b"\x1b[B")
            t.settle(0.6)
            assert "Welcome to the" in t.text() and "First note." not in t.text()
            t.snapshot("reading")

            # Next document with ] (preloaded neighbour), back with [.
            t.send(b"]")
            t.wait_for("First note.")
            t.snapshot("next")
            t.send(b"[")
            t.wait_for("Welcome to the")

            # Find by name: the field owns the letters, Enter opens the pick.
            t.send(b"/")
            t.wait_for("name or path")
            t.send(b"beta")
            t.wait_for("notes/deep/beta note.md")
            t.snapshot("find")
            t.send(b"\r")
            t.wait_for("A name with a space.")

            # Scroll the long guide: page, end, top.
            t.send(b"/")
            t.send(b"guide")
            t.send(b"\r")
            t.wait_for("The long document of the library.")
            t.wait_for("Top")
            t.send(b" ")
            t.wait_for("Top", absent=True)
            t.send(b"G")
            t.wait_for("Last words of the guide.")
            t.wait_for("Bot")
            t.snapshot("end")
            t.send(b"g")
            t.wait_for("Top")

            # Outline: select Chapter 3, Enter keeps the position, the status names it.
            t.send(b"t")
            t.wait_for("outline")
            t.wait_for("Appendix")
            t.send(b"jjj")
            t.snapshot("outline")
            t.send(b"\r")
            t.wait_for("§ Chapter 3")
            t.snapshot("chapter")

            # A change on disk reloads the open document in place, position kept.
            guide = docs / "guide.md"
            guide.write_text(guide.read_text().replace("## Chapter 3", "## Chapter 3 (edited)"))
            t.wait_for("reloaded from disk")
            t.wait_for("§ Chapter 3 (edited)")
            t.snapshot("reloaded")
            (docs / "notes/gamma.md").write_text("# Gamma\n")
            t.wait_for("gamma.md")
            t.wait_for("5 documents")
            session.quit(t)

        # A single file: no library, the document has the screen and the keys.
        single = Session(docs / "guide.md", directory + "/state-single")
        with single as t:
            t.wait_for("The long document of the library.")
            t.settle(0.8)
            t.snapshot("single")
            shown = t.text()
            assert "┌─ library" not in shown and "find" not in shown and "tab" not in shown, shown
            t.send(b"\x1b[B")
            t.wait_for("Top", absent=True)
            single.quit(t)

    print(
        json.dumps(
            {
                "productionPTY": True,
                "concealedMarkdown": True,
                "ignoredDirectories": True,
                "listArrowsOpenTabFocusesDocument": True,
                "nextPreviousFindScrollOutline": True,
                "reloadInPlace": True,
                "singleFileFullScreen": True,
                "terminalRestored": True,
            },
            indent=2,
        )
    )


if __name__ == "__main__":
    main()
