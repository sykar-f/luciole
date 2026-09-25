#!/usr/bin/env python3
"""`airtty devtools` inspecting Notes under `airtty dev`, each in its own PTY.

Checks what a developer would: both processes connect, requests appear with their Server
side, the component tree holds a Server Component, paint flashing reaches the application's
terminal, the Router panel invalidates a route in the application, network conditions apply
live, and Server logs arrive."""
import pyte
import os, pty, select, subprocess, tempfile, time, fcntl, termios, struct, pathlib, shutil, json, signal

root = pathlib.Path(__file__).resolve().parents[1]
bun = shutil.which('bun')


class Term:
    def __init__(self, argv, env, width=120, height=34):
        self.master, slave = pty.openpty()
        fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', height, width, 0, 0))
        self.process = subprocess.Popen(argv, stdin=slave, stdout=slave, stderr=slave, env=env, cwd=root, start_new_session=True)
        os.close(slave)
        self.screen = pyte.Screen(width, height)
        self.stream = pyte.ByteStream(self.screen)

    def pump(self):
        while select.select([self.master], [], [], 0)[0]:
            try:
                data = os.read(self.master, 65536)
            except OSError:
                return
            if not data:
                return
            # Answer basic terminal queries. No GUI terminal or focus stealing.
            if b'\x1b[6n' in data:
                os.write(self.master, b'\x1b[1;1R')
            if b'\x1b[c' in data:
                os.write(self.master, b'\x1b[?1;2c')
            self.stream.feed(data)

    def text(self):
        return '\n'.join(line.rstrip() for line in self.screen.display)

    def send(self, keys):
        os.write(self.master, keys)

    def stop(self):
        if self.process.poll() is None:
            os.killpg(self.process.pid, signal.SIGTERM)
            try:
                self.process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                os.killpg(self.process.pid, signal.SIGKILL)
        os.close(self.master)


terms = []


def pump_all(seconds):
    deadline = time.monotonic() + seconds
    while True:
        for term in terms:
            term.pump()
        if time.monotonic() >= deadline:
            return
        time.sleep(.03)


def wait_for(term, needle, timeout=20):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        pump_all(0)
        if needle in term.text():
            return
        time.sleep(.03)
    raise AssertionError(f'missing {needle!r}\n{term.text()}')


with tempfile.TemporaryDirectory(prefix='airtty-pty-devtools-') as directory:
    socket = f'unix:{directory}/bus.sock'
    env = {**os.environ, 'TERM': 'xterm-256color', 'XDG_STATE_HOME': f'{directory}/state'}
    try:
        devtools = Term([bun, 'packages/airtty/src/cli.ts', 'devtools', '--listen', socket], env)
        terms.append(devtools)
        wait_for(devtools, 'AIRTTY_DEVTOOLS=')
        app = Term(
            [bun, 'packages/airtty/src/cli.ts', 'dev', '--app', 'examples/notes'],
            {**env, 'AIRTTY_DEVTOOLS': socket, 'BUN_OPTIONS': f'--preload={root}/packages/airtty/src/devtools/hook.ts', 'NOTES_DB': f'{directory}/notes.sqlite'},
        )
        terms.append(app)
        wait_for(app, 'First note', 60)
        wait_for(devtools, '● client notes')
        wait_for(devtools, '● server notes')
        # The first page: its row joins the Client's timings with the Server's.
        wait_for(devtools, '▣ /  ')
        wait_for(devtools, 'Server: request +')

        app.send(b'\r')
        wait_for(app, 'baseline')
        wait_for(devtools, '▣ /notes/1')

        devtools.send(b'2')
        wait_for(devtools, 'NoteEditor')
        wait_for(devtools, '◇ ')
        # Paint flashing: typing re-renders the editor, outlined in the application's terminal.
        devtools.send(b'h')
        wait_for(devtools, 'flashing in app')
        app.send(b'x')
        wait_for(app, '┌──', 3)
        devtools.send(b'h')

        devtools.send(b'4')
        wait_for(devtools, '/notes/$id')
        devtools.send(b'G')
        pump_all(.3)
        # The last match is the page: invalidating it renders it again, for that cause.
        devtools.send(b'k')
        pump_all(.3)
        devtools.send(b'i')
        devtools.send(b'1')
        wait_for(devtools, ' inv ')

        devtools.send(b'7')
        wait_for(devtools, 'added latency')
        devtools.send(b'm')
        wait_for(devtools, 'Applied to 1 Client')

        devtools.send(b'3')
        wait_for(devtools, '"ready":true')

        print(json.dumps({
            'devtoolsPTY': True,
            'processesConnected': 2,
            'serverTimingsJoined': True,
            'serverComponentInTree': True,
            'paintFlashingInApp': True,
            'routerInvalidation': True,
            'liveNetworkConditions': True,
            'serverLogs': True,
        }, indent=2))
    finally:
        for term in reversed(terms):
            term.stop()
