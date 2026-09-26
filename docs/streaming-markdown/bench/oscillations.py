import json,sys
fr=json.load(open(sys.argv[1]))
osc=0
for i in range(1,len(fr)-3):
  for r in range(1,len(fr[i])-5):
    a=fr[i-1][r].rstrip(); b=fr[i][r].rstrip()
    if a==b or not a: continue
    if any(fr[j][r].rstrip()==a for j in (i+1,i+2,i+3)): osc+=1
print('frames',len(fr),'oscillations',osc)
