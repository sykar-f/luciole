#!/usr/bin/env python3
"""Production Client session: restored after kill -9 and SIGTERM, deleted when the user quits."""
import pyte
import os, pty, select, signal, subprocess, tempfile, time, json, fcntl, termios, struct, pathlib, shutil
root=pathlib.Path(__file__).resolve().parents[1]
bun=shutil.which('bun')
with tempfile.TemporaryDirectory(prefix='airtty-restore-') as directory:
 state=pathlib.Path(directory)/'state';sessions=state/'airtty'/'notes'/'sessions'
 env={**os.environ,'TERM':'xterm-256color','NODE_ENV':'production','XDG_STATE_HOME':str(state)}
 server=subprocess.Popen([bun,'--conditions=react-server',str(root/'examples/notes/.airtty/server/index.js')],env={**env,'PORT':'0','NOTES_DB':directory+'/notes.sqlite','AIRTTY_TEST':'1'},stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
 url='http://127.0.0.1:'+str(json.loads(server.stdout.readline())['port'])
 master,slave=pty.openpty();fcntl.ioctl(slave,termios.TIOCSWINSZ,struct.pack('HHHH',28,110,0,0))
 client=None;screen=None;stream=None;captured=b''
 def start():
  global client,screen,stream,captured
  screen=pyte.Screen(110,28);stream=pyte.ByteStream(screen);captured=b''
  client=subprocess.Popen([bun,str(root/'examples/notes/.airtty/client/index.js'),'--url',url],stdin=slave,stdout=slave,stderr=slave,env=env,start_new_session=True)
 def pump():
  global captured
  if select.select([master],[],[],.05)[0]:
   try:data=os.read(master,65536)
   except OSError:return
   if b'\x1b[6n' in data:os.write(master,b'\x1b[1;1R')
   if b'\x1b[c' in data:os.write(master,b'\x1b[?1;2c')
   captured+=data;stream.feed(data)
 def wait_for(text,timeout=10):
  deadline=time.monotonic()+timeout
  while time.monotonic()<deadline:
   pump()
   if text in '\n'.join(screen.display) and captured.rfind(b'\x1b[?2026l')>captured.rfind(b'\x1b[?2026h'):return
  raise AssertionError(text+' missing\n'+'\n'.join(screen.display))
 def ended(sig=None):
  if sig:client.send_signal(sig)
  deadline=time.monotonic()+5
  while client.poll() is None and time.monotonic()<deadline:pump()
  client.wait(timeout=1)
 def saved():
  return sorted(p.name for p in sessions.glob('*.json')) if sessions.exists() else []
 try:
  start();wait_for('First note');os.write(master,b'\r');wait_for('baseline:')
  os.write(master,b'abc');wait_for('abc')
  time.sleep(.5);assert len(saved())==1,saved()
  mode=oct(os.stat(sessions/saved()[0]).st_mode&0o777);assert mode=='0o600',mode
  # A crash: nothing runs, the last write is what comes back.
  ended(signal.SIGKILL)
  start();wait_for('abc');wait_for('Unsaved Draft');assert len(saved())==1,saved()
  os.write(master,b'd');wait_for('abcd')
  # A signal (a closed terminal, a rebuild): the session is written before exit.
  ended(signal.SIGTERM);assert client.returncode==0,client.returncode
  start();wait_for('abcd');wait_for('Unsaved Draft')
  # Quitting on purpose: nothing is offered next time.
  os.write(master,b'\x03');ended();assert client.returncode==0,client.returncode
  assert saved()==[],saved()
  start();wait_for('First note');assert 'abcd' not in '\n'.join(screen.display)
  os.write(master,b'\x03');ended()
  print(json.dumps({'productionPTY':True,'restoredAfterKill':True,'restoredAfterSigterm':True,'privateFile':True,'deletedOnQuit':True},indent=2))
 finally:
  if client and client.poll() is None:client.kill();client.wait(timeout=5)
  if server.poll() is None:server.terminate();server.wait(timeout=5)
  os.close(master);os.close(slave)
