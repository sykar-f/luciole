#!/usr/bin/env python3
"""`airtty` without arguments in a real PTY: the launcher app lists an installed app,
launches it with the terminal to itself, comes back with its exit status, reports a
target that cannot launch and an unreachable registry, then quits cleanly. Offline."""
import pyte
import os, pty, select, subprocess, tempfile, time, json, fcntl, termios, struct, pathlib, shutil

root = pathlib.Path(__file__).resolve().parents[1]
bun = shutil.which('bun')
COLUMNS, ROWS = 110, 30
with tempfile.TemporaryDirectory(prefix='airtty-pty-launcher-') as directory:
    base = pathlib.Path(directory)
    # An installed app, as `airtty install` leaves it: its record and its binary.
    build = base / 'data/airtty/apps/demo/ab12'
    build.mkdir(parents=True)
    ran = base / 'ran'
    binary = build / 'demo'
    binary.write_text(f'#!/bin/sh\n# airtty-binary:1:demo:ab12:bun-test;\necho "demo ran $*" >> "{ran}"\nexit 3\n')
    binary.chmod(0o755)
    (base / 'data/airtty/apps/demo/installed.json').write_text(json.dumps({
        'app': 'demo', 'package': '@ada/demo', 'version': '1.0.0', 'buildId': 'ab12',
        'target': 'bun-test', 'registry': 'http://127.0.0.1:1', 'installedAt': '2026-09-24T00:00:00Z'}))
    env = {**os.environ, 'TERM': 'xterm-256color', 'XDG_DATA_HOME': str(base / 'data'),
           'XDG_STATE_HOME': str(base / 'state'), 'XDG_CONFIG_HOME': str(base / 'config'),
           'XDG_CACHE_HOME': str(base / 'cache'), 'AIRTTY_REGISTRY': 'http://127.0.0.1:1'}
    master, slave = pty.openpty()
    fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', ROWS, COLUMNS, 0, 0))
    before = termios.tcgetattr(slave)
    client = subprocess.Popen([bun, str(root / 'src/cli.ts')], cwd=directory, stdin=slave, stdout=slave,
                              stderr=slave, env=env, start_new_session=True)
    screen = pyte.Screen(COLUMNS, ROWS)
    stream = pyte.ByteStream(screen)
    captured = b''

    def shown():
        return '\n'.join(screen.display)

    def wait_for(needle, timeout=30):
        global captured
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            if needle in shown() and captured.rfind(b'\x1b[?2026l') >= captured.rfind(b'\x1b[?2026h'):
                return
            readable, _, _ = select.select([master], [], [], .05)
            if readable:
                try:
                    data = os.read(master, 65536)
                except OSError:
                    break
                if not data:
                    break
                if b'\x1b[6n' in data:
                    os.write(master, b'\x1b[1;1R')
                if b'\x1b[c' in data:
                    os.write(master, b'\x1b[?1;2c')
                captured += data
                stream.feed(data)
        raise AssertionError('PTY missing ' + repr(needle) + ';\n' + shown())

    try:
        wait_for('INSTALLED (1)')
        wait_for('@ada/demo@1.0.0')
        # Enter on the installed app: the launcher quits, the app runs, the launcher returns.
        captured = b''
        os.write(master, b'\r')
        wait_for('demo exited with 3')
        assert ran.read_text() == 'demo ran \n', ran.read_text()
        # A path that is no app: explained once back in the launcher.
        os.write(master, b'\t\t')
        time.sleep(.3)
        os.write(master, b'./nowhere')
        wait_for('./nowhere')
        captured = b''
        os.write(master, b'\r')
        wait_for('not an airtty app')
        # Words search the registry, here unreachable: the status line says so.
        os.write(master, b'\t\t')
        time.sleep(.3)
        os.write(master, b'notes')
        wait_for('notes')
        os.write(master, b'\r')
        wait_for('unreachable')
        os.write(master, b'\x03')
        deadline = time.monotonic() + 5
        while client.poll() is None and time.monotonic() < deadline:
            if select.select([master], [], [], .05)[0]:
                try:
                    os.read(master, 65536)
                except OSError:
                    break
        client.wait(timeout=1)
        assert client.returncode == 0, client.returncode
        assert termios.tcgetattr(slave) == before, 'terminal attributes not restored'
        # The launcher's Server wrote its log in the user's state directory, not the screen.
        assert (base / 'state/airtty/airtty/server.log').exists()
        print(json.dumps({'launcherPTY': True, 'launchedInstalledApp': True, 'returnedWithExitStatus': True,
                          'explainedBadTarget': True, 'explainedUnreachableRegistry': True,
                          'terminalRestored': True}, indent=2))
    finally:
        if client.poll() is None:
            client.kill()
            client.wait(timeout=5)
        os.close(master)
        os.close(slave)
