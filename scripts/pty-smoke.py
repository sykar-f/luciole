#!/usr/bin/env python3
"""Real production Client PTY. Isolated DB, delayed Server, output observation (not photon latency)."""
import pyte
import os, pty, select, subprocess, tempfile, time, json, fcntl, termios, struct, pathlib, shutil, argparse
parser=argparse.ArgumentParser();parser.add_argument('--url');parser.add_argument('--client',default='examples/notes/.airtty/client/index.js');args=parser.parse_args()
root=pathlib.Path(__file__).resolve().parents[1]
bun=shutil.which('bun');env={**os.environ,'TERM':'xterm-256color','NODE_ENV':'production'}
with tempfile.TemporaryDirectory(prefix='airtty-pty-') as directory:
 server=None;master=None;client=None
 try:
  if args.url:url=args.url
  else:
   server=subprocess.Popen([bun,'--conditions=react-server',str(root/'examples/notes/.airtty/server/index.js')],env={**env,'PORT':'0','NOTES_DB':directory+'/notes.sqlite','NOTES_DELAY_MS':env.get('NOTES_DELAY_MS','700'),'AIRTTY_TEST':'1'},stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
   ready=json.loads(server.stdout.readline());url='http://127.0.0.1:'+str(ready['port'])
  master,slave=pty.openpty();fcntl.ioctl(slave,termios.TIOCSWINSZ,struct.pack('HHHH',28,110,0,0))
  before=termios.tcgetattr(slave)
  # A private state directory: the session file of this Client never reaches $HOME.
  client=subprocess.Popen([bun,str(root/args.client),'--url',url],stdin=slave,stdout=slave,stderr=slave,env={**env,'XDG_STATE_HOME':directory+'/state'},start_new_session=True)
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
  wait_for(b'First note');captured=b''
  navigation_start=time.monotonic();os.write(master,b'\r');loading_ms=None;loading_rows=None
  def layout_rows():
   return [next(i for i,line in enumerate(screen.display) if marker in line) for marker in ['Personal notebook','┌','└','reconnect']]
  if int(env.get('AIRTTY_LATENCY_MS','0'))>=400:
   wait_for(b'Opening note 1');loading_ms=(time.monotonic()-navigation_start)*1000
   assert loading_ms<int(env['AIRTTY_LATENCY_MS'])*.8,loading_ms
   loading_rows=layout_rows()
  wait_for(b'baseline:');captured=b''
  if loading_rows is not None:assert layout_rows()==loading_rows,(loading_rows,layout_rows())
  os.write(master,b'abc');wait_for(b'abc');captured=b''
  os.write(master,b'\r');wait_for(b'Saving');captured=b''
  start=time.monotonic();os.write(master,b'd');wait_for(b'abcd');local_ms=(time.monotonic()-start)*1000
  assert local_ms<500,local_ms
  wait_for(b'baseline: abc');assert 'abcd' in '\n'.join(screen.display)
  captured=b'';os.write(master,b'\x1b');wait_for(b'YOUR NOTES');captured=b'';os.write(master,b'\r');wait_for(b'abcd')
  # The reopened note may first show the router's cached version 1; the saved note is
  # version 2 once revalidated. Waiting for it keeps docs/pty-frame.txt deterministic.
  wait_for(b'version 2')
  if server:
   server.terminate();server.wait(timeout=5);captured=b'';os.write(master,b'\x12');wait_for(b'Disconnected');captured=b'';os.write(master,b'e');wait_for(b'abcde')
  (root/'docs/pty-frame.txt').write_text('\n'.join(line.rstrip() for line in screen.display).rstrip()+'\n')
  if server:
   # A failed navigation reports its error in the page slot; no console overlay covers the UI.
   captured=b'';os.write(master,b'\x1b');wait_for(b'Ctrl+R to retry');time.sleep(.2)
   shown='\n'.join(screen.display);assert 'Personal notebook' in shown and 'Console' not in shown,shown
  os.write(master,b'\x03')
  deadline=time.monotonic()+5
  while client.poll() is None and time.monotonic()<deadline:
   if select.select([master],[],[],.05)[0]:
    try: captured+=os.read(master,65536)
    except OSError: break
  client.wait(timeout=1);assert client.returncode==0,client.returncode
  after=termios.tcgetattr(slave);assert before==after,'terminal attributes not restored'
  result={'productionPTY':True,'navigationLoadingToPTYOutputMs':round(loading_ms,2) if loading_ms is not None else None,'stableLoadingLayout':loading_rows is not None,'saveWhileTyping':True,'draftAcrossNavigation':True,'typingToPTYOutputMs':round(local_ms,2),'simulatedRTTMs':int(env.get('AIRTTY_LATENCY_MS','0')),'serverDelayMs':int(env.get('NOTES_DELAY_MS','700')) if server else 'remote configuration','offlineEditing':bool(server),'terminalRestored':True,'transport':'external Server (topology supplied by caller)' if args.url else 'loopback','physicalDisplayLatencyMeasured':False}
  print(json.dumps(result,indent=2))
 finally:
  if client and client.poll() is None:
   client.kill();client.wait(timeout=5)
  if server and server.poll() is None:server.terminate();server.wait(timeout=5)
  if master is not None:os.close(master);os.close(slave)
