#!/usr/bin/env python3
"""Files explorer production smoke: built artefacts, separate Server and Client, real PTY.

Journey on a fixture tree: root listing → filter → image preview (half blocks, since the
PTY answers no kitty query) → text preview with line numbers → open a directory (loading
screen under latency) → code preview → back to the parent with the selection kept →
dotfiles → binary hex dump → zoom → quit. Observes PTY output, not photons.

Build first: bun src/cli.ts build --app examples/files
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
import zlib

import pyte

ROOT = pathlib.Path(__file__).resolve().parents[1]
APP = ROOT / "examples/files"
BUN = shutil.which("bun")
COLS, ROWS = 140, 40
LATENCY_MS = int(os.environ.get("AIRTTY_LATENCY_MS", "500"))
ENV = {**os.environ, "TERM": "xterm-256color", "NODE_ENV": "production"}


def png(width, height):
    """A truecolor gradient, encoded by hand: no image library needed."""
    def chunk(kind, data):
        body = kind + data
        return struct.pack(">I", len(data)) + body + struct.pack(">I", zlib.crc32(body))

    rows = b"".join(
        b"\x00" + b"".join(bytes([x * 255 // width, y * 255 // height, 160]) for x in range(width))
        for y in range(height)
    )
    header = struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0)
    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", header) + chunk(b"IDAT", zlib.compress(rows)) + chunk(b"IEND", b"")


def fixture(base):
    tree = base / "tree"
    (tree / "src/nested").mkdir(parents=True)
    (tree / "src/app.ts").write_text("export const answer: number = 42;\n" * 3)
    (tree / "README.md").write_text("# Fixture\n\nSecond paragraph line.\n")
    (tree / ".hidden").write_text("secret\n")
    (tree / "picture.png").write_bytes(png(48, 32))
    (tree / "data.bin").write_bytes(bytes(range(256)) * 2)
    (tree / "link").symlink_to("src")
    (tree / "broken").symlink_to("nowhere")
    # Listed, but the Server refuses to follow it: it resolves outside the root.
    (base / "outside").mkdir()
    (tree / "escape").symlink_to(base / "outside")
    (base / "bin").mkdir()
    for tool in ("pbcopy", "wl-copy"):
        (base / "bin" / tool).write_text(f"#!/bin/sh\n/bin/cat > '{base}/clipboard.txt'\n")
        (base / "bin" / tool).chmod(0o755)
    # Files to drop on the terminal, from outside the explorer root.
    (base / "incoming").mkdir()
    (base / "incoming/photo one.png").write_bytes(png(8, 8))
    (base / "incoming/notes.txt").write_text("copied, not moved\n")
    (base / "incoming/notes link.txt").symlink_to("notes.txt")
    (base / "incoming/README.md").write_text("same name as the root README\n")
    return tree


class Terminal:
    def __init__(self, master):
        self.master = master
        self.screen = pyte.Screen(COLS, ROWS)
        self.stream = pyte.ByteStream(self.screen)
        self.raw = b""
        self.apc = b""

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
        self.stream.feed(self.without_apc(data))

    def without_apc(self, data):
        # pyte prints APC strings (kitty graphics: ESC _ G … ESC \\) as text: drop them
        # from what it sees, even when one spans several reads. `raw` keeps them.
        data, self.apc, shown = self.apc + data, b"", b""
        while data:
            start = data.find(b"\x1b_")
            if start < 0:
                return shown + data
            end = data.find(b"\x1b\\", start)
            if end < 0:
                self.apc = data[start:]
                return shown + data[:start]
            shown, data = shown + data[:start], data[end + 2 :]
        return shown

    def wait(self, needle, timeout=15):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            self.pump()
            # Synchronized output: wait for the end of the last frame update.
            if needle in self.text() and self.raw.rfind(b"\x1b[?2026l") >= self.raw.rfind(b"\x1b[?2026h"):
                return time.monotonic()
        raise AssertionError(f"missing {needle!r}\n{self.text()}")

    def settle(self, seconds=0.4):
        deadline = time.monotonic() + seconds
        while time.monotonic() < deadline:
            self.pump()

    def send(self, keys):
        os.write(self.master, keys)

    def drop(self, *paths):
        # What Ghostty sends when files are dropped: shell-escaped paths, bracketed paste.
        escaped = " ".join(str(p).replace(" ", "\\ ") for p in paths)
        self.send(b"\x1b[200~" + escaped.encode() + b"\x1b[201~")

    def click(self, text, button=0):
        # SGR mouse report, 1-based cells: press then release on the first cell of `text`.
        row = next(i for i, line in enumerate(self.screen.display) if text in line)
        col = self.screen.display[row].index(text)
        for final in (b"M", b"m"):
            self.send(b"\x1b[<%d;%d;%d" % (button, col + 1, row + 1) + final)

    def escape(self):
        # A lone ESC: the next key must not follow at once, or it reads as Alt+key.
        self.send(b"\x1b")
        self.settle(0.3)

    def filter(self, text):
        # The field takes focus on the next frame: type once it owns the keys.
        self.send(b"/")
        self.wait("return done")
        self.send(text)
        self.settle(0.2)
        self.send(b"\r")


def main():
    with tempfile.TemporaryDirectory(prefix="airtty-files-") as directory:
        base = pathlib.Path(directory)
        tree = fixture(base)
        server = client = master = slave = None
        try:
            server = subprocess.Popen(
                [BUN, "--conditions=react-server", str(APP / ".airtty/server/index.js")],
                env={
                    **ENV,
                    "PORT": "0",
                    "FILES_ROOT": str(tree),
                    "AIRTTY_TEST": "1",
                    # Thumbnails are cached here, never in the user's ~/.cache.
                    "XDG_CACHE_HOME": str(base / "cache"),
                },
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
            )
            url = "http://127.0.0.1:" + str(json.loads(server.stdout.readline())["port"])
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
                    "XDG_STATE_HOME": str(base / "state"),
                    "AIRTTY_LATENCY_MS": str(LATENCY_MS),
                    # A fake clipboard tool: copies land in a file, never in the user's clipboard.
                    "PATH": str(base / "bin"),
                },
                start_new_session=True,
            )
            t = Terminal(master)
            t.wait("TERMINAL / FILES")
            t.wait("src/")
            # Dotfiles are hidden by default; directories come first.
            assert ".hidden" not in t.text()
            assert t.text().index("src/") < t.text().index("README.md")

            # Filter narrows locally; Enter leaves the field with the match selected.
            t.filter(b"pict")
            t.wait("1/8 shown")
            t.wait("drawn with truecolor half blocks (auto)")
            t.wait("48×32 px")
            # The image arrives as a Server thumbnail (never enlarged), not as the file.
            t.wait("PNG 48×32 · thumbnail 48×32")
            assert any((base / "cache/airtty-files/thumbnails").glob("*.webp")), "no cached thumbnail"
            shown = t.text()
            assert "PNG image" in shown, shown
            assert "▀" in shown or "▄" in shown, "no half-block glyph in the image pane"
            # Half blocks carry two truecolor pixels per cell: the gradient needs many colours.
            colours = {
                (cell.fg, cell.bg)
                for row in t.screen.buffer.values()
                for cell in row.values()
                if cell.data in "▀▄█▌▐"
            }
            assert len(colours) > 20, f"image pane is not truecolor: {len(colours)} colour pairs"
            # `p` forces kitty graphics: OpenTUI then emits APC `ESC _ G` image commands.
            t.raw = b""
            t.send(b"p")
            t.wait("drawn with kitty (forced)")
            t.settle()
            assert b"\x1b_G" in t.raw, "no kitty graphics command after forcing the protocol"
            t.send(b"p")
            t.wait("drawn with truecolor half blocks (forced)")
            t.send(b"p")
            t.wait("(auto)")

            # Esc clears the filter; README shows its text with line numbers.
            t.escape()
            t.wait("7/8 shown")
            t.send(b"G")
            t.wait("name      README.md")
            t.wait("Second paragraph line.")
            t.wait("markdown · 3 lines")
            t.wait("1 # Fixture")
            t.wait("3 Second paragraph line.")
            t.wait("Markdown")

            # Opening a directory is a navigation: loading frame under latency, then listing.
            t.send(b"g")
            t.wait("name      escape")
            t.send(b"j")
            t.wait("name      link")
            t.send(b"j")
            t.wait("name      src")
            start = time.monotonic()
            t.send(b"\r")
            if LATENCY_MS >= 400:
                t.wait("Opening src…")
            t.wait("name      nested")
            opened_ms = (time.monotonic() - start) * 1000
            t.send(b"j")
            t.wait("export const answer")
            t.wait("typescript · 3 lines")

            # Backspace returns to the parent with the directory we came from selected.
            t.send(b"\x7f")
            t.wait("name      src")
            t.wait("app.ts")  # the directory preview of src lists its children

            # Sorting is local and keeps the selection.
            t.send(b"s")
            t.wait("by size")
            t.wait("name      src")
            t.send(b"s")
            t.wait("by modified")
            t.send(b"s")
            t.wait("by name")

            # A symlink to a directory inside the root opens; ~ returns to the root.
            t.filter(b"link")
            t.wait("name      link")
            t.send(b"\r")
            t.wait("tree › link")
            t.wait("app.ts")
            t.send(b"~")
            t.wait("tree · 8 entries")

            # Dotfiles on demand, and the binary preview.
            t.send(b".")
            t.wait(".hidden")
            t.wait("dotfiles shown")
            t.filter(b"data")
            t.wait("00000000  00 01 02 03")
            t.wait("512 B · 512 bytes")
            t.escape()

            # Zoom a file: the list disappears, Esc brings it back.
            t.filter(b"READ")
            t.wait("Second paragraph line.")
            t.send(b"\r")
            t.settle()
            assert " details " not in t.text(), t.text()
            t.escape()
            t.wait(" details ")

            # Right-click on a row: its context menu, which owns the keyboard until closed.
            t.click("≡ README.md", button=2)
            t.wait("Copy full path")
            t.send(b"j")
            t.settle()
            assert "name      README.md" in t.text(), "the list moved under the menu"
            t.escape()
            assert "Copy full path" not in t.text()
            t.click("≡ README.md", button=2)
            t.wait("Copy name")
            t.click("Copy name")
            t.wait("Copied name: README.md")
            assert (base / "clipboard.txt").read_text() == "README.md"
            t.click("≡ README.md", button=2)
            t.wait("Copy full path")
            t.click("Copy full path")
            t.wait("Copied full path:")
            assert (base / "clipboard.txt").read_text() == str(tree.resolve() / "README.md")
            # From the keyboard: m opens it on the selected row, Enter runs the first item.
            t.send(b"m")
            t.wait("Preview full screen")
            t.send(b"\r")
            t.settle()
            assert " details " not in t.text(), "Enter did not open the preview full screen"
            t.escape()
            t.wait(" details ")

            # A broken symlink is listed and reported, never followed.
            t.escape()
            t.filter(b"broken")
            t.wait("Broken symlink")

            # Following a link out of the root is refused by the Server, not by the Client.
            t.escape()
            t.filter(b"escape")
            t.wait("Symlink to directory")
            t.send(b"\r")
            t.wait("escape not found")
            t.wait("outside the explorer root")
            t.send(b"\r")
            t.wait("picture.png")
            if os.environ.get("FILES_PTY_FRAME"):
                pathlib.Path(os.environ["FILES_PTY_FRAME"]).write_text(t.text() + "\n")

            # Drag and drop: applied on release. The file shows at once as a ghost row at
            # its sorted place, then becomes the real entry. A file of this machine moves.
            incoming = base / "incoming"
            t.escape()
            t.drop(incoming / "photo one.png")
            if LATENCY_MS >= 400:
                t.wait("↓ photo one.png")
                t.wait("arriving…")
                assert "is arriving into the root" in t.text(), t.text()
            t.wait("moved photo one.png")
            t.wait("name      photo one.png")
            t.wait("-rw-r--r--")  # the real entry, from the refreshed listing
            assert "arriving…" not in t.text()
            assert not (incoming / "photo one.png").exists() and (tree / "photo one.png").exists()
            # Sorted place: between picture.png and README.md.
            shown = t.text()
            assert shown.index("picture.png") < shown.index("photo one.png") < shown.index("README.md") or (
                shown.index("photo one.png") < shown.index("picture.png")
            ), shown
            # A dropped symlink is not "the same file" for the Server: its content is sent
            # and copied, as for a Server on another machine; the link and its target stay.
            t.drop(incoming / "notes link.txt")
            t.wait("copied notes link.txt")
            assert (incoming / "notes link.txt").is_symlink() and (incoming / "notes.txt").exists()
            assert (tree / "notes link.txt").read_text() == "copied, not moved\n"
            assert not (tree / "notes link.txt").is_symlink()
            # Never overwritten.
            t.drop(incoming / "README.md")
            t.wait("README.md: a file with this name is already here")
            assert (tree / "README.md").read_text().startswith("# Fixture")

            t.send(b"\x03")
            deadline = time.monotonic() + 5
            while client.poll() is None and time.monotonic() < deadline:
                t.pump()
            assert client.returncode == 0, client.returncode
            after = termios.tcgetattr(slave)
            assert after == before, f"terminal attributes not restored: {before} -> {after}"
            print(
                json.dumps(
                    {
                        "productionPTY": True,
                        "simulatedRTTMs": LATENCY_MS,
                        "filterLocal": True,
                        "imageHalfBlocks": True,
                        "imageTruecolorPairs": len(colours),
                        "serverThumbnailCached": True,
                        "kittyWhenForced": True,
                        "textPreviewWithLineNumbers": True,
                        "openDirectoryMs": round(opened_ms),
                        "parentKeepsSelection": True,
                        "localSort": True,
                        "symlinkDirectoryAndRootKey": True,
                        "dotfilesToggle": True,
                        "binaryHexDump": True,
                        "zoom": True,
                        "contextMenuRightClick": True,
                        "contextMenuCopies": True,
                        "brokenSymlinkReported": True,
                        "symlinkOutsideRootRefused": True,
                        "dropGhostRow": LATENCY_MS >= 400,
                        "dropMovesWhenLocal": True,
                        "dropCopiesWhenNotSameFile": True,
                        "dropNeverOverwrites": True,
                        "terminalRestored": True,
                    },
                    indent=2,
                )
            )
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
