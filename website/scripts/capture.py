#!/usr/bin/env python3
"""Capture real screens of the example applications for the website.

A scene starts a program in a PTY, plays keys, and writes the screen pyte decoded (text,
colours, attributes) to src/frames/<name>.json. Most scenes start an example with
`luciole dev`; `flow-graph` runs its package's example with Bun alone, as its README does,
and `flight` writes the Server's bytes to src/frames/flight.txt, with no PTY. The site
renders those cells as HTML: what it shows is what the terminal received, not a mock-up.

  python3 website/scripts/capture.py              # every scene
  python3 website/scripts/capture.py forge files  # some scenes
  python3 website/scripts/capture.py --print forge  # also print the text of each frame

Needs pyte (`pip install pyte`, in a virtual environment) and a checkout where
`bun install` ran.
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
CLI = str(ROOT / "packages/core/src/cli.ts")
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

    def erase_line(self, needle):
        """Blank the row where a process wrote `needle` to the terminal on its own (stderr),
        outside the interface the application draws: the frame keeps the interface only."""
        for y, row in enumerate(self.screen.display):
            if needle in row:
                self.stream.feed(f"\x1b[{y + 1};1H\x1b[2K".encode())

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


def find(term, needle, after=0):
    """(row, column) of the first `needle` on the screen at or below row `after`."""
    for row, text in enumerate(term.screen.display):
        if row >= after and needle in text:
            return row, text.index(needle)
    raise AssertionError(f"{needle!r} is not on the screen\n{term.text()}")


def span(term, needle, after=0):
    """The rectangle of a piece of text, located on the screen so a new recording moves it."""
    row, col = find(term, needle, after)
    return {"row": row, "col": col, "rows": 1, "cols": len(needle)}


def band(term, first, last, col=0, cols=None):
    """The rectangle from the row of `first` to the row of `last` (both included)."""
    top, _ = find(term, first)
    bottom, _ = find(term, last, top)
    return {"row": top, "col": col, "rows": bottom - top + 1, "cols": cols or term.screen.columns - col}


def save(term, name, title, replace=(), regions=None):
    """`replace`: (text, shown instead) pairs of this scene, before the private paths.

    `regions`: numbered callouts, [{id, side, rects}] in cells, as `Screen.astro` draws them.
    """
    OUT.mkdir(parents=True, exist_ok=True)
    frame = {"title": title, "cols": term.screen.columns, "rows": term.screen.lines, "cells": anonymous(cells(term.screen), replace)}
    if regions:
        frame["regions"] = regions
    (OUT / f"{name}.json").write_text(json.dumps(frame, ensure_ascii=False, separators=(",", ":")) + "\n")
    print(f"captured {name}", flush=True)
    if PRINT:
        print(term.text())


def dev(app, env, directory, cols, rows, cwd=ROOT):
    return Terminal(
        [BUN, CLI, "dev", "--app", str(app) if isinstance(app, pathlib.Path) else str(ROOT / "examples" / app)],
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
        save(term, "notes", "Notes: the first note open")
    finally:
        term.stop()


NOTES_SIZE = (84, 24)


def notes_term(directory, env=None, app="notes"):
    """Notes with a fresh database, started until the list shows (no note open)."""
    term = dev(app, {"NOTES_DB": directory + "/notes.sqlite", **(env or {})}, directory, *NOTES_SIZE)
    term.wait_for("Welcome to Notes", 120)
    term.idle(1)
    return term


def stop_server(term):
    """Kill the Server `luciole dev` started, and leave the Client running."""
    listing = subprocess.run(["ps", "-axo", "pid=,ppid=,command="], capture_output=True, text=True, check=True).stdout
    pids = []
    for line in listing.splitlines():
        pid, parent, command = line.split(None, 2)
        # This capture's Server: a child of its `luciole dev`, running the built server.
        if int(parent) == term.process.pid and ".luciole/server/index.js" in command:
            pids.append(int(pid))
    assert pids, "no Server to stop\n" + listing
    for pid in pids:
        os.kill(pid, signal.SIGKILL)


def notes_empty(directory):
    term = notes_term(directory)
    try:
        term.wait_for("No note selected", 30)
        save(term, "notes-empty", "Notes: started, no note open")
    finally:
        term.stop()


def notes_pick(directory):
    # The first change of Getting started (docs/getting-started.mdx, step 2): the heading of
    # components/NoNoteShown.tsx. The copy lives under the checkout, whose node_modules
    # resolve the packages, in a directory .gitignore knows (.luciole-*/).
    app = pathlib.Path(tempfile.mkdtemp(prefix=".luciole-capture-notes-", dir=ROOT))
    try:
        shutil.copytree(ROOT / "examples/notes", app, dirs_exist_ok=True, ignore=shutil.ignore_patterns(".luciole", "node_modules"))
        heading = app / "components/NoNoteShown.tsx"
        source = heading.read_text()
        assert "No note selected" in source
        heading.write_text(source.replace("No note selected", "Pick a note"))
        term = notes_term(directory, app=app)
        try:
            term.wait_for("Pick a note", 30)
            save(term, "notes-pick", "Notes: the heading after the first change")
        finally:
            term.stop()
    finally:
        shutil.rmtree(app, ignore_errors=True)


def notes_loading(directory):
    # LUCIOLE_LATENCY_MS: every request takes a second and a half, so the navigation shows
    # app/notes/[id]/loading.tsx in the page's slot, the layouts around it still drawn.
    term = notes_term(directory, {"LUCIOLE_LATENCY_MS": "3000"})
    try:
        term.send(b"\r")
        term.wait_for("Loading the note", 30)
        term.idle(0.5)
        save(term, "notes-loading", "Notes: a navigation under latency")
    finally:
        term.stop()


def notes_error(directory):
    # With the Server gone, opening a note cannot reach it: the navigation fails with a
    # TransportError, and app/error.tsx replaces the page only.
    term = notes_term(directory)
    try:
        stop_server(term)
        term.idle(1)
        term.send(b"\r")
        term.wait_for("Try again", 30)
        term.idle(1)
        save(term, "notes-error", "Notes: error.tsx in the page's slot")
    finally:
        term.stop()


def notes_disconnected(directory):
    # LUCIOLE_PING_MS: the Client pings its Server every half second, not every ten, so it
    # notices the loss at once; the status line then waits its own 3 s before saying it.
    term = notes_term(directory, {"LUCIOLE_PING_MS": "500"})
    try:
        # The status line belongs to a note's pane: open the first note, as `notes` does.
        term.send(b"\r")
        term.wait_for("Getting around", 30)
        term.idle(1)
        stop_server(term)
        term.idle(1)
        term.send(b"\x12")  # Ctrl+R: a refresh nobody can answer
        term.wait_for("Reconnect", 60)
        term.idle(1)
        term.erase_line("Unable to connect")
        save(term, "notes-disconnected", "Notes: the Server gone")
    finally:
        term.stop()


# The line typed before the crash, at the end of the Idea note: one line long, so the note
# shows it without scrolling after the relaunch (the editor's scroll is not restored).
RESTORED_WORDS = "And by week, for the journal."


def close(term):
    """Stop a Terminal whose process may have ended already, killed or quit."""
    if term.process.poll() is None:
        term.stop()
    else:
        os.close(term.master)


def ended(term, timeout=30):
    """Wait for a Terminal's process to end, reading what it writes meanwhile."""
    deadline = time.monotonic() + timeout
    while term.process.poll() is None:
        assert time.monotonic() < deadline, f"still running\n{term.text()}"
        term.pump()


def session_restore(directory):
    # The steps of scripts/pty/lifetime.ts: `luciole ./examples/notes`, whose Server waits in
    # grace for the next launch, words typed and left unsaved, the Client killed with
    # SIGKILL, then launched again. A launch, not `luciole dev`, which would restart it.
    # Under /tmp: a Unix socket's path is short (104 bytes on macOS).
    runtime = tempfile.mkdtemp(prefix="luciole-rt-", dir="/tmp")
    env = {
        **os.environ, "TERM": "xterm-256color", "COLORTERM": "truecolor",
        "XDG_STATE_HOME": directory + "/state", "XDG_RUNTIME_DIR": runtime,
        "NOTES_DB": directory + "/notes.sqlite",
        # Nothing saves by itself: the words are still unsaved when they come back.
        "NOTES_AUTOSAVE_MS": "0",
    }
    launch = lambda: Terminal([BUN, CLI, str(ROOT / "examples/notes")], env, *NOTES_SIZE)
    sessions = pathlib.Path(directory, "state/luciole/notes/sessions")
    try:
        term = launch()
        try:
            term.wait_for("Welcome to Notes", 120)
            term.idle(1)
            # Down through the list to its last note, Idea, one line long.
            for _ in range(20):
                if "What if the list" in term.text():
                    break
                term.send(b"\x1b[B", pause=0.5)
            term.wait_for("What if the list", 30)
            term.send(b"\x05", pause=0.4)  # Ctrl+E: the cursor at the end of the text
            term.send(b"\r" + RESTORED_WORDS.encode())
            term.wait_for(RESTORED_WORDS)
            term.wait_for("● Unsaved")
            # The session file is written 200 ms after the last change.
            term.idle(1)
            save(term, "session-restore-before", "Notes: words typed, not saved")
            (file,) = sessions.glob("*.json")
            os.kill(json.loads(file.read_text())["pid"], signal.SIGKILL)
            ended(term)
        finally:
            close(term)
        term = launch()
        try:
            term.wait_for(RESTORED_WORDS, 120)
            term.wait_for("● Unsaved")
            term.idle(1)
            save(term, "session-restore-after", "Notes: launched again after kill -9")
            # Quitting on purpose stops the Server the first launch started.
            term.send(b"\x03", pause=0)
            ended(term)
        finally:
            close(term)
    finally:
        # A Server a failed capture left behind: SIGTERM ends it, its socket gives its pid.
        for socket in pathlib.Path(runtime, "luciole").glob("*.sock"):
            status = subprocess.run(["curl", "-s", "--max-time", "2", "--unix-socket", str(socket), "http://localhost/lifetime/status"], capture_output=True, text=True).stdout
            if status:
                os.kill(json.loads(status)["pid"], signal.SIGTERM)
        shutil.rmtree(runtime, ignore_errors=True)


def latency(directory):
    # LUCIOLE_LATENCY_MS: the round trip of guides/latency-and-faults.mdx, long enough that
    # the typing below lands while `ping` waits, and the screen says so.
    term = dev("latency", {"LUCIOLE_LATENCY_MS": "2000"}, directory, 84, 24)
    try:
        term.wait_for("Enter sends a request", 120)
        term.idle(1)
        save(term, "latency", "Latency: a playground with a slow Server")
        term.send(b"\r", pause=0.1)
        term.send(b"still typing", pause=0.1)
        term.wait_for("Input: still typing", 1)
        assert "Waiting for Server" in term.text(), term.text()
        save(term, "latency-waiting", "Latency: typing while the Server answers")
    finally:
        term.stop()


def files(directory):
    # A tree of its own, made of this checkout's files: the capture does not depend on the
    # checkout's name or location, on what it holds besides these files, or on the day (each
    # file is dated eight hours before the capture, as the first one was seen).
    project = pathlib.Path(directory) / "luciole"
    project.mkdir()
    for name in ("README.md", "CHANGELOG.md", "CONTRIBUTING.md", "LICENSE", "bunfig.toml", "package.json"):
        shutil.copy(ROOT / name, project / name)
    shutil.copytree(ROOT / "docs", project / "docs", ignore=shutil.ignore_patterns("*.txt", "missions"))
    (project / "tests").mkdir()
    for test in sorted((ROOT / "tests").iterdir()):
        if test.is_file() and test.suffix in (".ts", ".tsx"):
            shutil.copy(test, project / "tests" / test.name)
    when = time.time() - 8 * 3600
    for path in (*project.rglob("*"), project):
        os.utime(path, (when, when))
    term = dev("files", {"FILES_ROOT": str(project), "TZ": "UTC", "LANG": "en_US.UTF-8"}, directory, 140, 40)
    try:
        term.wait_for("docs/", 120)
        term.idle(1)
        # docs/ comes first, then tests/: open it, and go down to the second file.
        term.send(b"j", 0.1)
        term.send(b"\r")
        term.idle(1)
        term.send(b"jj")
        term.idle(1.5)
        save(term, "files", "Files: an explorer with previews", replace=[(str(project.resolve()), "/home/ada/src/luciole")])
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


def markdown_editor(directory):
    # The program of packages/markdown-editor/README.md, run as a reader runs it: Bun on the
    # file, no Luciole app around it.
    term = Terminal(
        [BUN, str(ROOT / "packages/markdown-editor/example/index.tsx")],
        # TERM_PROGRAM: heading bands take octant ends only in terminals that draw them (Ghostty,
        # kitty, WezTerm); the frame shows the square ones, which every font has.
        {**os.environ, "TERM": "xterm-256color", "COLORTERM": "truecolor", "TERM_PROGRAM": "xterm"},
        72, 13,
    )
    try:
        term.wait_for("Packing list", 60)
        term.idle(1.5)
        save(term, "markdown-editor", "@luciole-sh/markdown-editor: a note, as it reads")
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
        [BUN, CLI, "dev", "--app", str(ROOT / "packages/core/src/devtools/luciole-devtools")],
        {**os.environ, "TERM": "xterm-256color", "COLORTERM": "truecolor", "XDG_STATE_HOME": directory + "/state", "LUCIOLE_DESKTOP": "1",
         "LUCIOLE_DEVTOOLS_LISTEN": "none", "LUCIOLE_DEVTOOLS_DEMO": "1"},
        100, 30,
    )
    try:
        term.wait_for("Network", 120)
        term.idle(4)
        # Numbered in reading order, from the top: the two processes, the requests, and the
        # Server's own timing of the selected request (the stream `watch`).
        save(term, "devtools-network", "DevTools: requests of both processes", regions=[
            {"id": "1", "side": "client", "rects": [span(term, "client notes 4101")]},
            {"id": "2", "side": "server", "rects": [span(term, "server notes 4100")]},
            {"id": "3", "side": "client", "rects": [band(term, "name", "ƒ watch")]},
            {"id": "4", "side": "server", "rects": [span(term, "Server: request +2ms · headers +4ms · end –")]},
        ])
        term.send(b"2")
        term.wait_for("components", 30)
        term.idle(2)
        # The tree, with the one component that runs on the Server; the flag; the detail.
        server = span(term, "NotePage Server")
        top = band(term, "Layout ×1", "NotesLayout ×1")
        below = band(term, "NoteEditor", "KeyHelp")
        save(term, "devtools-components", "DevTools: Client and Server components", regions=[
            {"id": "1", "side": "client", "rects": [top, below]},
            {"id": "2", "side": "server", "rects": [server]},
            {"id": "3", "side": "client", "rects": [span(term, "⚠ unnecessary")]},
            {"id": "4", "side": "client", "rects": [band(term, "Layout · 1 renders", "state:")]},
        ])
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


def build_tree(directory):
    """What `luciole build --compile` leaves in Notes' .luciole/: the layout, without sizes or hashes."""
    app = ROOT / "examples/notes"
    subprocess.run([BUN, CLI, "build", "--app", str(app), "--compile"], check=True,
                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    hashed = re.compile(r"-[0-9a-z]{8}(\.\w+)$")
    platform = re.compile(r"^(darwin|linux|windows)-(x64|arm64)(-musl)?$")

    def listing(path, depth):
        # Files before directories, so a file's name is first met at its own level.
        entries = sorted(path.iterdir(), key=lambda p: (p.is_dir(), p.name))
        lines, extensions = [], set()
        for entry in entries:
            match = hashed.search(entry.name)
            if entry.is_file() and match:
                extensions.add(match.group(1))
            elif entry.is_dir():
                name = "<os>-<arch>" if platform.match(entry.name) else entry.name
                lines += ["  " * depth + name + "/", *listing(entry, depth + 1)]
            else:
                lines.append("  " * depth + entry.name)
        if extensions:
            lines.append("  " * depth + "<asset>-<hash>" + ", ".join(sorted(extensions)))
        return lines

    body = "\n".join([".luciole/", *listing(app / ".luciole", 1)]) + "\n"
    OUT.mkdir(parents=True, exist_ok=True)
    (OUT / "build-tree.txt").write_text(body)
    print(f"captured build-tree ({len(body.splitlines())} lines)")
    if PRINT:
        print(body)


def flow_graph(directory):
    # The minimal program of packages/flow-graph/README.md, run as a reader runs it: no
    # luciole, only Bun, React and OpenTUI. `fitView` makes the first frame the one shown.
    term = Terminal(
        [BUN, str(ROOT / "packages/flow-graph/example/main.tsx")],
        {**os.environ, "TERM": "xterm-256color", "COLORTERM": "truecolor"},
        72, 20, ROOT / "packages/flow-graph/example",
    )
    try:
        term.wait_for("checkout", 60)
        term.idle(1.5)
        save(term, "flow-graph", "@luciole-sh/flow-graph: a node graph in the terminal")
    finally:
        term.stop()


SCENES = {"forge": forge, "notes": notes, "notes-empty": notes_empty, "notes-pick": notes_pick, "notes-loading": notes_loading, "notes-error": notes_error, "notes-disconnected": notes_disconnected,
          "session-restore": session_restore,
          "latency": latency, "chat": chat, "coder": coder, "files": files, "mdreader": mdreader, "markdown-editor": markdown_editor, "devtools": devtools, "mux": mux, "flight": flight, "build-tree": build_tree, "flow-graph": flow_graph}


def main():
    names = [a for a in sys.argv[1:] if not a.startswith("--")] or list(SCENES)
    for name in names:
        with tempfile.TemporaryDirectory(prefix=f"luciole-capture-{name}-") as directory:
            SCENES[name](directory)


if __name__ == "__main__":
    main()
