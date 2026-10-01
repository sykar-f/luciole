#!/usr/bin/env python3
"""Capture real screens of the example applications for the website.

Each scene starts an application with `luciole dev` in a PTY, plays keys, and writes the
screen pyte decoded (text, colours, attributes) to src/frames/<name>.json. The site
renders those cells as HTML: what it shows is what the terminal received, not a mock-up.

  python3 website/scripts/capture.py              # every scene
  python3 website/scripts/capture.py forge files  # some scenes
  python3 website/scripts/capture.py --print forge  # also print the text of each frame

Needs pyte (scripts/requirements-pty.txt) and a checkout where `bun install` ran.
"""
import datetime
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
import sys
import tempfile
import termios
import time
import urllib.parse
import urllib.request

import pyte

SITE = pathlib.Path(__file__).resolve().parents[1]
ROOT = SITE.parent
OUT = SITE / "src/frames"
BUN = shutil.which("bun")
CLI = str(ROOT / "packages/luciole/src/cli.ts")
# The seed's clock (examples/forge/server/seed.ts) plus 22 days, as in scripts/pty-forge.py:
# the ages Forge shows do not depend on the day of the capture.
FORGE_CLOCK = "2026-09-23T09:00:00Z"
# When every document was last modified, as the live demo dates them (scripts/demo.ts,
# DOCS_CLOCK): a checkout dates its files from the moment it was made.
DOCS_CLOCK = "2026-09-23T09:00:00Z"
PRINT = "--print" in sys.argv


class Terminal:
    def __init__(self, argv, env, cols, rows, cwd=ROOT):
        self.master, slave = pty.openpty()
        fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))
        self.process = subprocess.Popen(
            argv, stdin=slave, stdout=slave, stderr=slave, cwd=cwd, env=env,
            start_new_session=True,
        )
        os.close(slave)
        self.screen = pyte.Screen(cols, rows)
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

    def settled(self):
        # Synchronized output: the last frame update has ended.
        return self.raw.rfind(b"\x1b[?2026l") >= self.raw.rfind(b"\x1b[?2026h")

    def wait_for(self, needle, timeout=60):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            if needle in self.text() and self.settled():
                return
            self.pump()
        raise AssertionError(f"never showed {needle!r}\n{self.text()}")

    def idle(self, seconds):
        end = time.monotonic() + seconds
        while time.monotonic() < end:
            self.pump(0.02)

    def send(self, data, pause=0.25):
        os.write(self.master, data)
        self.idle(pause)

    def stop(self):
        try:
            os.killpg(self.process.pid, signal.SIGTERM)
            self.process.wait(timeout=5)
        except (ProcessLookupError, subprocess.TimeoutExpired):
            os.killpg(self.process.pid, signal.SIGKILL)
        os.close(self.master)


def colour(value, default):
    if value == "default":
        return default
    if len(value) == 6 and all(c in "0123456789abcdefABCDEF" for c in value):
        return "#" + value.lower()
    return value  # a named ANSI colour; the site maps it


def cells(screen):
    """Rows of runs: [text, fg, bg, flags], adjacent cells of one style merged."""
    rows = []
    for y in range(screen.lines):
        line = screen.buffer[y]
        runs = []
        for x in range(screen.columns):
            char = line[x]
            fg, bg = colour(char.fg, None), colour(char.bg, None)
            if char.reverse:
                fg, bg = bg or "bg", fg or "fg"
            flags = "".join(f for f, on in (("b", char.bold), ("i", char.italics), ("u", char.underscore)) if on)
            style = [fg, bg, flags]
            if runs and runs[-1][1:] == style:
                runs[-1][0] += char.data
            else:
                runs.append([char.data, *style])
        # Trailing default-styled blanks carry nothing.
        while runs and runs[-1][0].strip() == "" and runs[-1][2] is None:
            runs.pop()
        rows.append(runs)
    return rows


# The checkout's absolute path is the capturer's, not the reader's: each occurrence becomes
# a neutral path padded to the same width, so right-aligned text stays where it was.
PRIVATE = [(str(ROOT), "/home/ada/src/luciole"), (str(ROOT).replace(str(pathlib.Path.home()), "~"), "~/src/luciole")]


TMPDIR = re.compile(r"/var/folders/[^/]+/[^/]+/T/")


def anonymous(rows, extra=()):
    """Replace private paths; the columns they free go to the next gap after them.

    Padding right after the path would split a sentence ("/tmp/     name.sock"); putting
    the spaces into the next run of blanks keeps right-aligned text where it was.
    """
    patterns = [(re.compile(re.escape(private)), public) for private, public in (*extra, *PRIVATE)]
    patterns.append((TMPDIR, "/tmp/"))
    for runs in rows:
        deficit = 0
        last = None  # (run index, offset) just after the last replacement
        for index, run in enumerate(runs):
            for pattern, public in patterns:
                while match := pattern.search(run[0]):
                    run[0] = run[0][: match.start()] + public + run[0][match.end() :]
                    deficit += len(match.group()) - len(public)
                    last = (index, match.start() + len(public))
        if not deficit:
            continue
        for index in range(last[0], len(runs)):
            start = last[1] if index == last[0] else 0
            gap = runs[index][0].find("  ", start)
            if gap >= 0:
                text = runs[index][0]
                runs[index][0] = text[:gap] + " " * deficit + text[gap:]
                break
        else:
            runs[-1][0] += " " * deficit
    return rows


def save(term, name, title, replace=()):
    """`replace`: (text, shown instead) pairs of this scene, before the private paths."""
    OUT.mkdir(parents=True, exist_ok=True)
    frame = {"title": title, "cols": term.screen.columns, "rows": term.screen.lines, "cells": anonymous(cells(term.screen), replace)}
    (OUT / f"{name}.json").write_text(json.dumps(frame, ensure_ascii=False, separators=(",", ":")) + "\n")
    print(f"captured {name}", flush=True)
    if PRINT:
        print(term.text())


def dev(app, env, directory, cols, rows, cwd=ROOT):
    return Terminal(
        [BUN, CLI, "dev", "--app", str(ROOT / "examples" / app)],
        # LUCIOLE_DESKTOP: Ctrl+C belongs to the application, as in a page, so the key help
        # the capture shows is the one the live demo it stands in for draws.
        {**os.environ, "TERM": "xterm-256color", "COLORTERM": "truecolor", "XDG_STATE_HOME": directory + "/state", "LUCIOLE_DESKTOP": "1", **env},
        cols, rows, cwd,
    )


def forge(directory):
    term = dev("forge", {
        # No FORGE_GIT_REPO: the live demo in the page cannot import a git repository,
        # and the capture it replaces must show the same repositories.
        "FORGE_DB": directory + "/forge.sqlite",
        "FORGE_CLOCK_START": FORGE_CLOCK, "FORGE_SLOW_MS": "0", "FORGE_CI_SCALE": "0.05",
    }, directory, 140, 40)
    try:
        term.wait_for("Demo accounts", 120)
        term.send(b"alice\r")
        term.send(b"forge\r")
        term.wait_for("RECENT ACTIVITY")
        term.idle(1)
        save(term, "forge-home", "Forge: repositories and activity")
        term.send(b"1")
        term.wait_for("open pull request(s)")
        term.send(b"/")
        term.send(b"idempotency")
        term.send(b"\x1b", pause=0.4)
        term.send(b"\r")
        term.wait_for("[m] merge")
        term.idle(1.5)
        save(term, "forge-pr", "Forge: a pull request")
        term.send(b"\t")
        term.idle(1.5)
        term.send(b"]")
        term.send(b"]")
        term.idle(2)
        save(term, "forge-files", "Forge: a diff")
    finally:
        term.stop()


def notes(directory):
    term = dev("notes", {"NOTES_DB": directory + "/notes.sqlite"}, directory, 84, 24)
    try:
        term.wait_for("Welcome to Notes", 120)
        term.idle(1)
        # The hero's duel opens on the first note (Hero.astro, `path`): so does its capture.
        term.send(b"\r")
        term.wait_for("Getting around", 30)
        term.idle(1)
        save(term, "notes", "Notes: a Server 500 ms away")
    finally:
        term.stop()


def files(directory):
    term = dev("files", {"FILES_ROOT": str(ROOT)}, directory, 140, 40)
    try:
        term.wait_for("README.md", 120)
        term.idle(1)
        for key in b"jjjjjj":
            term.send(bytes([key]), 0.1)
        term.send(b"\r")
        term.idle(1)
        term.send(b"jj")
        term.idle(1.5)
        save(term, "files", "Files: an explorer with previews")
    finally:
        term.stop()


def mdreader(directory):
    # The live demo's files (website/scripts/demo.ts): the site's documentation in Markdown
    # (website/scripts/docs-md.ts), all modified at DOCS_CLOCK, shown in UTC and in
    # English, as a reader in the page may see them.
    docs = pathlib.Path(directory) / "docs"
    clock = datetime.datetime.fromisoformat(DOCS_CLOCK).timestamp()
    subprocess.run([BUN, str(ROOT / "website/scripts/docs-md.ts"), str(docs)], check=True, stdout=subprocess.DEVNULL)
    for page in docs.rglob("*.md"):
        os.utime(page, (clock, clock))
    term = dev("mdreader", {"MD_PATH": str(docs), "TZ": "UTC", "LANG": "en_US.UTF-8"}, directory, 140, 40)
    try:
        term.wait_for("getting-started", 120)
        term.idle(1.5)
        # The live demo reads the same files from /docs.
        save(term, "mdreader", "mdreader: Markdown in two panes", [(str(docs), "/docs")])
    finally:
        term.stop()


def chat(directory):
    # CHAT_DEMO: the scripted model the page's live demo answers with, in the Server.
    term = dev("chat", {"CHAT_DEMO": "1"}, directory, 140, 40)
    try:
        term.wait_for("Ask anything", 120)
        term.send(b"How does luciole keep typing local when the Server is 500 ms away?\r")
        term.wait_for("Done.", 60)
        term.idle(1)
        save(term, "chat", "Chat: streamed answers")
    finally:
        term.stop()


# The live demo's scripted session (scripts/demo.ts, packages/harness/src/adapters/fake.ts):
# the same project path on both screens, the same prompt, the same approval.
CODER_CWD = "/home/ada/src/timers"
CODER_PROMPT = 'parseDuration("abc") returns NaN: make it throw a clear error, then run its tests'


def coder(directory):
    term = dev("coder", {"CODER_HARNESS": "fake", "CODER_CWD": CODER_CWD}, directory, 140, 40)
    try:
        term.wait_for("Scripted demo · no model calls", 120)
        term.send(CODER_PROMPT.encode() + b"\r")
        term.wait_for("allow once", 60)
        term.send(b"y")
        term.wait_for("Your turn: ask for the next change.", 60)
        term.idle(1)
        save(term, "coder", "coder: a coding agent's session, scripted")
    finally:
        term.stop()


def devtools(directory):
    # The DevTools application as the live demo runs it (scripts/demo.ts): the demo session
    # with no bus, so no socket for an application to join and no instructions to join it,
    # which `luciole devtools --demo` would show.
    term = Terminal(
        [BUN, CLI, "dev", "--app", str(ROOT / "packages/luciole/src/devtools/luciole-devtools")],
        {**os.environ, "TERM": "xterm-256color", "COLORTERM": "truecolor", "XDG_STATE_HOME": directory + "/state", "LUCIOLE_DESKTOP": "1",
         "LUCIOLE_DEVTOOLS_LISTEN": "none", "LUCIOLE_DEVTOOLS_DEMO": "1"},
        140, 40,
    )
    try:
        term.wait_for("Network", 120)
        term.idle(4)
        save(term, "devtools-network", "DevTools: requests of both processes")
        term.send(b"2")
        term.idle(2)
        save(term, "devtools-components", "DevTools: Client and Server components")
    finally:
        term.stop()


def mux(directory):
    subprocess.run([BUN, CLI, "build", "--app", str(ROOT / "examples/mdreader")], check=True, stdout=subprocess.DEVNULL)
    docs = subprocess.Popen(
        [BUN, "--conditions=react-server", str(ROOT / "examples/mdreader/.luciole/server/index.js")],
        env={**os.environ, "NODE_ENV": "production", "PORT": "0", "MD_PATH": str(ROOT / "docs/ROUTER.md")},
        stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True,
    )
    url = "http://127.0.0.1:" + str(json.loads(docs.stdout.readline())["port"])
    apps = [{"name": "docs", "bundle": str(ROOT / "examples/mdreader/.luciole/app"), "url": url}]
    term = dev("mux", {
        "SHELL": "/bin/sh", "PS1": "$ ", "ENV": "",
        "MUX_PANES": json.dumps([["/bin/sh"], ["vim", "--clean", "examples/notes/app/notes/[id]/page.tsx"]]),
        "MUX_APPS": json.dumps(apps),
    }, directory, 140, 40)
    try:
        term.wait_for("$ ", 120)
        term.idle(2)
        term.send(b"git log --oneline -12\r", 1)
        save(term, "mux", "mux: a shell, vim and a luciole app side by side")
    finally:
        term.stop()
        docs.terminate()


def flight(directory):
    """The bytes the Server sends for a note: React Flight, as the Client receives them."""
    app = ROOT / "examples/notes"
    subprocess.run([BUN, CLI, "build", "--app", str(app)], check=True, stdout=subprocess.DEVNULL)
    build = json.loads((app / ".luciole/manifest.json").read_text())["buildId"]
    server = subprocess.Popen(
        [BUN, "--conditions=react-server", str(app / ".luciole/server/index.js")],
        env={**os.environ, "NODE_ENV": "production", "PORT": "0", "LUCIOLE_TOKEN": "capture",
             "NOTES_DB": directory + "/notes.sqlite"},
        stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True,
    )
    try:
        port = json.loads(server.stdout.readline())["port"]
        query = urllib.parse.urlencode({"route": "/notes/[id]", "params": json.dumps({"id": "1"})})
        request = urllib.request.Request(
            f"http://127.0.0.1:{port}/render?{query}",
            headers={"authorization": "Bearer capture", "x-luciole-build": build, "x-luciole-call": "capture"},
        )
        body = urllib.request.urlopen(request).read().decode()
        OUT.mkdir(parents=True, exist_ok=True)
        (OUT / "flight.txt").write_text(body)
        print(f"captured flight ({len(body)} bytes)")
        if PRINT:
            print(body)
    finally:
        server.terminate()


SCENES = {"forge": forge, "notes": notes, "chat": chat, "coder": coder, "files": files, "mdreader": mdreader, "devtools": devtools, "mux": mux, "flight": flight}


def main():
    names = [a for a in sys.argv[1:] if not a.startswith("--")] or list(SCENES)
    for name in names:
        with tempfile.TemporaryDirectory(prefix=f"luciole-capture-{name}-") as directory:
            SCENES[name](directory)


if __name__ == "__main__":
    main()
