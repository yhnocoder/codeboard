# Turns tiles-out/**/*.jpg into WebP (q75) and drops tiles that are nothing but the board's background colour
import glob, json, os, sys
from concurrent.futures import ProcessPoolExecutor
from PIL import Image

def conv(a):
    f, bg = a
    im = Image.open(f).convert("RGB")
    lo, hi = im.convert("L").getextrema()
    px = im.getpixel((0, 0))
    plain = hi - lo <= 3 and all(abs(p - q) <= 6 for p, q in zip(px, bg))
    os.remove(f)
    if plain: return 0
    out = f[:-4] + ".webp"
    im.save(out, "WEBP", quality=75, method=4)
    return 1

jobs = []
for m in glob.glob(sys.argv[1] + "/*/manifest.json"):
    man = json.load(open(m))
    bg = tuple(int(man["bg"][i:i+2], 16) for i in (1, 3, 5))
    jobs += [(f, bg) for f in glob.glob(os.path.dirname(m) + "/*/*.jpg")]
with ProcessPoolExecutor(4) as ex:
    kept = sum(ex.map(conv, jobs, chunksize=64))
print(len(jobs), "tiles,", kept, "kept")
