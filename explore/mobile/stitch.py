import json,sys
from PIL import Image
d,lv,scale=sys.argv[1],int(sys.argv[2]),float(sys.argv[3])
m=json.load(open(f"{d}/manifest.json"));L=m["levels"][lv]
W=H=0
im=Image.new("RGB",(L["cols"]*512,L["rows"]*512),"white")
for r in range(L["rows"]):
  for c in range(L["cols"]):
    t=Image.open(f"{d}/{lv}/{c}_{r}.jpg");im.paste(t,(c*512,r*512));W=max(W,c*512+t.width);H=max(H,r*512+t.height)
im=im.crop((0,0,W,H));im=im.resize((int(W*scale),int(H*scale)));im.save(sys.argv[4])
