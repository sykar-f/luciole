#!/usr/bin/env python3
"""Real production Client PTY. Isolated DB, delayed Server, output observation (not photon latency)."""
import pyte
import os, pty, select, subprocess, tempfile, time, json, fcntl, termios, struct, pathlib, shutil, argparse
parser=argparse.ArgumentParser();parser.add_argument('--url');parser.add_argument('--client',default='examples/notes/.terminal/client/index.js');args=parser.parse_args()
root=pathlib.Path(__file__).resolve().parents[1]
bun=shutil.which('bun');env={**os.environ,'TERM':'xterm-256color','NODE_ENV':'production'}
with tempfile.TemporaryDirectory(prefix='terminal-pty-') as directory:
 server=None;master=None;client=None
 try:
  if args.url:url=args.url
  else:
   server=subprocess.Popen([bun,'--conditions=react-server',str(root/'examples/notes/.terminal/server/index.js')],env={**env,'PORT':'0','NOTES_DB':directory+'/notes.sqlite','NOTES_DELAY_MS':'700','TERMINAL_TEST':'1'},stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
   ready=json.loads(server.stdout.readline());url='http://127.0.0.1:'+str(ready['port'])
  master,slave=pty.openpty();fcntl.ioctl(slave,termios.TIOCSWINSZ,struct.pack('HHHH',28,110,0,0))
  before=termios.tcgetattr(slave)
  client=subprocess.Popen([bun,str(root/args.client),'--url',url],stdin=slave,stdout=slave,stderr=slave,env=env,start_new_session=True)
  captured=b''
  screen=pyte.Screen(110,28);stream=pyte.ByteStream(screen)
  def wait_for(needle,timeout=10):
   global captured
   deadline=time.monotonic()+timeout
   while time.monotonic()<deadline:
    if needle.decode() in '\n'.join(screen.display) and captured.rfind(b'\x1b[?2026l') > captured.rfind(b'\x1b[?2026h'):return
    readable,_,_=select.select([master],[],[],.05)
    if readable:
     try:data=os.read(master,65536)
     except OSError:break
     if not data:break
     # Answer basic terminal queries. No GUI terminal or focus stealing.
     if b'\x1b[6n' in data:os.write(master,b'\x1b[1;1R')
     if b'\x1b[c' in data:os.write(master,b'\x1b[?1;2c')
     captured+=data;stream.feed(data)
   raise AssertionError('PTY missing '+repr(needle)+'; tail='+repr(captured[-3000:]))
  wait_for(b'First note');captured=b'';os.write(master,b'\r');wait_for(b'baseline:');captured=b''
  os.write(master,b'abc');wait_for(b'abc');captured=b''
  os.write(master,b'\r');wait_for(b'Saving');captured=b''
  start=time.monotonic();os.write(master,b'd');wait_for(b'abcd');local_ms=(time.monotonic()-start)*1000
  assert local_ms<500,local_ms
  wait_for(b'baseline: abc');assert 'abcd' in '\n'.join(screen.display)
  captured=b'';os.write(master,b'\x1b');wait_for(b'YOUR NOTES');captured=b'';os.write(master,b'\r');wait_for(b'abcd')
  if server:
   server.terminate();server.wait(timeout=5);captured=b'';os.write(master,b'\x12');wait_for(b'Disconnected');captured=b'';os.write(master,b'e');wait_for(b'abcde')
  (root/'docs/pty-frame.txt').write_text('\n'.join(line.rstrip() for line in screen.display).rstrip()+'\n')
  os.write(master,b'\x03')
  deadline=time.monotonic()+5
  while client.poll() is None and time.monotonic()<deadline:
   if select.select([master],[],[],.05)[0]:
    try: captured+=os.read(master,65536)
    except OSError: break
  client.wait(timeout=1);assert client.returncode==0,client.returncode
  after=termios.tcgetattr(slave);assert before==after,'terminal attributes not restored'
  result={'productionPTY':True,'saveWhileTyping':True,'draftAcrossNavigation':True,'typingToPTYOutputMs':round(local_ms,2),'serverDelayMs':700 if server else 'remote configuration','offlineEditing':bool(server),'terminalRestored':True,'transport':'external Server (topology supplied by caller)' if args.url else 'loopback','physicalDisplayLatencyMeasured':False}
  print(json.dumps(result,indent=2))
 finally:
  if client and client.poll() is None:
   client.kill();client.wait(timeout=5)
  if server and server.poll() is None:server.terminate();server.wait(timeout=5)
  if master is not None:os.close(master);os.close(slave)
