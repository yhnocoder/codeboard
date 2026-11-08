#!/usr/bin/env python3
"""Writes a fake 2-board tile set in the tiles-out format, for building and trying the app
before the real renderer's output exists.

    python3 tools/fake_tiles.py [out dir]   (default: fake-tiles next to this folder)
"""
import json
import math
import os
import random
import sys

from PIL import Image, ImageDraw, ImageFont

TILE = 512
DPR = 2
BG = "#efebe4"
INK = (58, 47, 37)
SECOND = (138, 123, 107)
CARD = (250, 247, 241)
LINE = (214, 205, 192)


def font(size):
    for path in (
        "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
        "/usr/share/fonts/dejavu/DejaVuSans.ttf",
    ):
        if os.path.exists(path):
            return ImageFont.truetype(path, size)
    return ImageFont.load_default()


def board(out, bid, name, world, cards, hits, seed, summary_label):
    rnd = random.Random(seed)
    x0, y0, ww, wh = world
    top = 1.0
    full = Image.new("RGB", (int(ww * top * DPR), int(wh * top * DPR)), BG)
    d = ImageDraw.Draw(full)
    s = top * DPR

    def W(x, y):
        return ((x - x0) * s, (y - y0) * s)

    title = font(int(22 * s))
    body = font(int(13 * s))
    for (cx, cy, cw, ch, label) in cards:
        a, b = W(cx, cy)
        c, e = W(cx + cw, cy + ch)
        d.rounded_rectangle((a, b, c, e), radius=8 * s, fill=CARD, outline=LINE, width=int(1.5 * s))
        d.text((a + 14 * s, b + 10 * s), label, fill=INK, font=title)
        y = b + 48 * s
        while y < e - 20 * s:
            words = " ".join(rnd.choice(["for", "tile", "grid", "block", "warp", "sum", "load", "x[i]", "+=", "kernel"]) for _ in range(rnd.randint(3, 8)))
            d.text((a + 14 * s, y), words, fill=SECOND, font=body)
            y += 22 * s
    for (rect, _target) in hits:
        a, b = W(rect[0], rect[1])
        c, e = W(rect[0] + rect[2], rect[1] + rect[3])
        d.rounded_rectangle((a, b, c, e), radius=10 * s, outline=INK, width=int(3 * s))

    zs = [1.0, 0.5, 0.25, 0.125, 0.0625]
    levels = []
    bdir = os.path.join(out, bid)
    for i, z in enumerate(zs):
        if z == top:
            img = full
        else:
            img = full.resize((max(1, round(ww * z * DPR)), max(1, round(wh * z * DPR))), Image.LANCZOS)
            if z <= 0.25:
                # the "summary" look of the low levels
                dd = ImageDraw.Draw(img)
                f = font(max(10, int(80 * z * DPR)))
                for (cx, cy, cw, ch, label) in cards:
                    a, b = (cx - x0) * z * DPR, (cy - y0) * z * DPR
                    dd.rectangle((a, b, a + cw * z * DPR, b + ch * z * DPR), fill=(232, 224, 212), outline=INK)
                    dd.text((a + 4, b + 4), label, fill=INK, font=f)
        cols = math.ceil(img.width / TILE)
        rows = math.ceil(img.height / TILE)
        levels.append({"z": z, "cols": cols, "rows": rows})
        ldir = os.path.join(bdir, str(i))
        os.makedirs(ldir, exist_ok=True)
        tag = font(14)
        for c in range(cols):
            for r in range(rows):
                t = img.crop((c * TILE, r * TILE, min(img.width, (c + 1) * TILE), min(img.height, (r + 1) * TILE))).copy()
                ImageDraw.Draw(t).text((4, 4), f"L{i} {c},{r}", fill=(190, 178, 160), font=tag)
                if c == cols - 1 and r == 0 and i == 0:
                    continue  # a missing tile means plain background
                t.save(os.path.join(ldir, f"{c}_{r}.webp"), quality=82)
        if cols * rows <= 1:
            break
    manifest = {
        "id": bid,
        "name": name,
        "world": {"x": x0, "y": y0, "w": ww, "h": wh},
        "tile": TILE,
        "dpr": DPR,
        "levels": levels,
        "bg": BG,
        "hits": [{"rect": {"x": r[0], "y": r[1], "w": r[2], "h": r[3]}, "board": t} for (r, t) in hits],
    }
    with open(os.path.join(bdir, "manifest.json"), "w") as f:
        json.dump(manifest, f, indent=1)
    return len(cards)


def main():
    out = sys.argv[1] if len(sys.argv) > 1 else os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "fake-tiles")
    os.makedirs(out, exist_ok=True)
    root_cards = [(-40 + (i % 3) * 760, -20 + (i // 3) * 620, 680, 520, f"Card {i + 1}") for i in range(9)]
    root_hits = [((1480, 1220, 680, 520), "fake-sub")]
    n1 = board(out, "fake-root", "Fake root board", (-80, -60, 2400, 1900), root_cards, root_hits, 1, "root")
    sub_cards = [(i * 520, j * 400, 460, 340, f"Sub {i},{j}") for i in range(3) for j in range(3)]
    n2 = board(out, "fake-sub", "A sub-board with a fairly long name to ellipsize", (-40, -40, 1640, 1240), sub_cards, [], 2, "sub")
    index = [
        {"id": "fake-root", "name": "Fake root board", "cards": n1, "subs": ["fake-sub"]},
        {"id": "fake-sub", "name": "A sub-board with a fairly long name to ellipsize", "cards": n2},
    ]
    with open(os.path.join(out, "index.json"), "w") as f:
        json.dump(index, f, indent=1)
    print("wrote", out)


if __name__ == "__main__":
    main()
