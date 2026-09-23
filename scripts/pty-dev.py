#!/usr/bin/env python3
"""Dev compiler failure is displayed inside the still-editable Client; a valid rebuild reopens the page with its named fields; shutdown reaps both children."""
import os,pty,select,subprocess,tempfile,time,json,fcntl,termios,struct,pathlib,shutil,pyte
root=pathlib.Path(__file__).resolve().parents[1];bun=shutil.which('bun')
with tempfile.TemporaryDirectory(prefix='airtty-dev-') as directory:
 app=pathlib.Path(directory)/'app-source';shutil.copytree(root/'examples/notes',app,ignore=shutil.ignore_patterns('.airtty','*.sqlite*'))
 master,slave=pty.openpty();fcntl.ioctl(slave,termios.TIOCSWINSZ,struct.pack('HHHH',32,140,0,0));before=termios.tcgetattr(slave)
 sessions=pathlib.Path(directory)/'state'/'airtty'/'app-source'/'sessions'
 dev=subprocess.Popen([bun,str(root/'src/cli.ts'),'dev','--app',str(app)],stdin=slave,stdout=slave,stderr=slave,env={**os.environ,'TERM':'xterm-256color','NOTES_DB':directory+'/notes.sqlite','XDG_STATE_HOME':directory+'/state'},start_new_session=True)
 screen=pyte.Screen(140,32);stream=pyte.ByteStream(screen);raw=b''
 def pump():
  global raw
  if select.select([master],[],[],.03)[0]:
   try:data=os.read(master,65536)
   except OSError:return
   raw+=data;stream.feed(data)
   if b'\x1b[6n' in data:os.write(master,b'\x1b[1;1R')
   if b'\x1b[c' in data:os.write(master,b'\x1b[?1;2c')
 def wait(text,timeout=20):
  start=time.monotonic()
  while time.monotonic()-start<timeout:
   pump()
   if text in '\n'.join(screen.display) and raw.rfind(b'\x1b[?2026l')>raw.rfind(b'\x1b[?2026h'):return
  raise AssertionError(text+' missing\n'+'\n'.join(screen.display))
 try:
  wait('First note');os.write(master,b'\r');wait('baseline:');os.write(master,b'keep');wait('keep')
  children=[int(pid) for pid in subprocess.check_output(['pgrep','-P',str(dev.pid)],text=True).split()];assert len(children)==2,children
  page=app/'app/page.tsx';original=page.read_text();page.write_text('export default async function Page(){"use server";return <text>bad</text>}')
  wait('Build failed:');os.write(master,b'!');wait('keep!')
  # The restarted Client reopens the note, and the text typed in its named field.
  page.write_text(original+'\n// valid rebuild\n');deadline=time.monotonic()+20;new_children=children
  while set(children)&set(new_children) or len(new_children)!=2:
   assert time.monotonic()<deadline,'the rebuild never restarted both children'
   # Between the two generations pgrep finds no child and exits 1.
   pump();new_children=[int(pid) for pid in subprocess.run(['pgrep','-P',str(dev.pid)],capture_output=True,text=True).stdout.split()]
  # Only the new Client draws from here on: the note and its typed text come back.
  screen.reset();wait('Unsaved Draft');wait('keep!')
  os.write(master,b'\x03');deadline=time.monotonic()+5
  while dev.poll() is None and time.monotonic()<deadline:pump()
  dev.wait(timeout=1);assert dev.returncode==0
  assert termios.tcgetattr(slave)==before,'terminal attributes not restored'
  assert not list(sessions.glob('*.json')),'a quit session was kept'
  for pid in children+new_children:
   try:os.kill(pid,0)
   except ProcessLookupError:continue
   raise AssertionError('orphan process '+str(pid))
  print(json.dumps({'devPTY':True,'buildErrorShown':True,'typingAfterBuildError':True,'successfulRebuildRestarts':True,'rebuildRestoresPageAndFields':True,'quitDeletesSession':True,'terminalRestored':True,'noOrphanChildren':True},indent=2))
 finally:
  if dev.poll() is None:
   import signal
   os.killpg(dev.pid,signal.SIGKILL);dev.wait()
  os.close(master);os.close(slave)
