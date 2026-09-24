#!/usr/bin/env python3
"""`airtty ./examples/notes` in a real PTY, across the Server's lifetime: a Client killed
with SIGKILL leaves its Server in grace; the next launch attaches to that same Server and
restores the route and the typed text; an unreachable Server shows Disconnected, then
Connected once it answers again; Ctrl+C stops the Server. Offline."""
import pyte
import os, pty, select, signal, socket, subprocess, tempfile, time, json, fcntl, termios, struct, pathlib, shutil

root = pathlib.Path(__file__).resolve().parents[1]
bun = shutil.which('bun')
COLUMNS, ROWS = 110, 28


def status(path):
    """GET /lifetime/status on a managed Server's socket, or None."""
    try:
        with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as s:
            s.settimeout(2)
            s.connect(str(path))
            s.sendall(b'GET /lifetime/status HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n')
            data = b''
            while chunk := s.recv(65536):
                data += chunk
        return json.loads(data.split(b'\r\n\r\n', 1)[1])
    except (OSError, ValueError, IndexError):
        return None


with tempfile.TemporaryDirectory(prefix='airtty-pty-lifetime-') as directory, \
        tempfile.TemporaryDirectory(prefix='airtty-rt-', dir='/tmp') as runtime:
    base = pathlib.Path(directory)
    sessions = base / 'state/airtty/notes/sessions'
    env = {**os.environ, 'TERM': 'xterm-256color', 'XDG_STATE_HOME': str(base / 'state'),
           'XDG_RUNTIME_DIR': runtime, 'NOTES_DB': str(base / 'notes.sqlite'), 'AIRTTY_PING_MS': '500'}
    master, slave = pty.openpty()
    fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', ROWS, COLUMNS, 0, 0))
    state = {}

    def start():
        state['screen'] = pyte.Screen(COLUMNS, ROWS)
        state['stream'] = pyte.ByteStream(state['screen'])
        state['captured'] = b''
        state['launcher'] = subprocess.Popen([bun, str(root / 'src/cli.ts'), str(root / 'examples/notes')],
                                             cwd=directory, stdin=slave, stdout=slave, stderr=slave, env=env,
                                             start_new_session=True)

    def shown():
        return '\n'.join(state['screen'].display)

    def pump():
        if select.select([master], [], [], .05)[0]:
            try:
                data = os.read(master, 65536)
            except OSError:
                return
            if b'\x1b[6n' in data:
                os.write(master, b'\x1b[1;1R')
            if b'\x1b[c' in data:
                os.write(master, b'\x1b[?1;2c')
            state['captured'] += data
            state['stream'].feed(data)

    def wait_for(text, timeout=30):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            pump()
            captured = state['captured']
            if text in shown() and captured.rfind(b'\x1b[?2026l') >= captured.rfind(b'\x1b[?2026h'):
                return
        raise AssertionError(text + ' missing\n' + shown())

    def ended(timeout=10):
        deadline = time.monotonic() + timeout
        while state['launcher'].poll() is None and time.monotonic() < deadline:
            pump()
        assert state['launcher'].poll() is not None, 'launcher still running'

    def server_socket():
        found = list((pathlib.Path(runtime) / 'airtty').glob('*.sock'))
        return found[0] if found else None

    try:
        start()
        wait_for('First note')
        os.write(master, b'\r')
        wait_for('baseline:')
        os.write(master, b'unsaved words')
        wait_for('unsaved words')
        time.sleep(.6)  # the session file is written 200 ms after the last change
        path = server_socket()
        first = status(path)
        assert first and first['clients'] == 1, first
        # The Client crashes: its Server waits in grace instead of going with it.
        client_pid = json.loads(next(sessions.glob('*.json')).read_text())['pid']
        os.kill(client_pid, signal.SIGKILL)
        ended()
        deadline = time.monotonic() + 5
        while not (status(path) or {}).get('graceUntil') and time.monotonic() < deadline:
            time.sleep(.1)
        in_grace = status(path)
        assert in_grace and in_grace['pid'] == first['pid'] and 'graceUntil' in in_grace, in_grace
        # Launched again: same Server, same page, the text as it was typed.
        start()
        wait_for('unsaved words')
        assert 'baseline:' in shown(), shown()
        again = status(path)
        assert again['pid'] == first['pid'] and 'graceUntil' not in again, again
        # The Server stops answering, then answers again: the Client follows, state kept.
        os.kill(first['pid'], signal.SIGSTOP)
        wait_for('Disconnected')
        os.kill(first['pid'], signal.SIGCONT)
        wait_for('Connected')
        assert 'unsaved words' in shown(), shown()
        # Quitting on purpose stops the Server.
        os.write(master, b'\x03')
        ended()
        deadline = time.monotonic() + 5
        while path.exists() and time.monotonic() < deadline:
            time.sleep(.1)
        assert not path.exists() and status(path) is None, 'Server still running'
        print(json.dumps({'lifetimePTY': True, 'crashKeepsServerInGrace': True, 'reattachedSameServer': True,
                          'routeAndFieldRestored': True, 'disconnectedThenConnected': True,
                          'quitStopsServer': True}, indent=2))
    finally:
        launcher = state.get('launcher')
        if launcher and launcher.poll() is None:
            launcher.kill()
        path = server_socket()
        leftover = status(path) if path else None
        if leftover:
            os.kill(leftover['pid'], signal.SIGCONT)
            os.kill(leftover['pid'], signal.SIGTERM)
        os.close(master)
        os.close(slave)
