// Export as PNG draws the board the way it looks on screen, in every look:
//  pngExportLooksLikeBoard — a Note (Latin, Chinese, a formula, bold) and a Free code card, exported in Warm Ink and Ink Wash:
//                            each card in the PNG matches its screenshot on the board (the export drew the theme's default
//                            look, with serif text and no paper: the theme class sits on <html>, which the SVG picture does not
//                            have, the fonts were not loaded inside it, and Ink Wash's unescaped `url("…")` on <html> broke it;
//                            \bigg uses KaTeX_Size3, whose src is a data: URL with a ; in it, which cut its @font-face short)
import * as fs from "node:fs";
import * as path from "node:path";
import { OUT } from "../harness";
import { emptyBoard, type Board } from "@codeboard/core";
import { test, open, check, idle, until } from "../fixtures";

function board(): Board {
  const b = emptyBoard("b1", "export");
  b.cards.push({
    id: "n1",
    kind: "note",
    look: "note",
    md: "## Prefill 一步\n\n先 **schedule** 挑出这一批，再交给 ModelRunner 跑模型。复杂度 $O(n^2)$，每步 $b \\cdot t$ 个 token，$\\bigg( \\sum_i x_i \\bigg)$。\n\n- waiting → running\n- 按 hash 复用前缀块",
  } as never);
  b.place.n1 = { x: 60, y: 60, w: 380 };
  b.cards.push({
    id: "f1",
    kind: "code",
    title: "schedule",
    segments: [
      {
        id: "sFree",
        src: { kind: "free" },
        path: "",
        lang: "python",
        start: 1,
        end: 3,
        text: ["def schedule(self, seq):", "    block = self.free[0]", "    return len(seq) * 2"],
        version: { kind: "none" },
      },
    ],
  } as never);
  b.place.f1 = { x: 500, y: 60, w: 360 };
  return b;
}

/** Share of the card's pixels that differ by more than 48 / 255: both pictures shrunk to a quarter (text antialiasing evens
 *  out), each pixel compared with the export's pixel and its eight neighbours (lines of text may sit a device pixel or two
 *  lower in the export) */
async function cardDiff(pg: import("playwright-core").Page, shot: string, png: string, crop: number[]) {
  return pg.evaluate(
    async ([shot, png, crop]) => {
      const load = async (u: string) => {
        const im = new Image();
        im.src = u;
        await im.decode();
        return im;
      };
      const [a, b] = await Promise.all([load(shot as string), load(png as string)]);
      const [x, y, w, h] = crop as number[];
      const W = Math.round(a.naturalWidth / 4),
        H = Math.round(a.naturalHeight / 4);
      const px = (im: HTMLImageElement, sx: number, sy: number, sw: number, sh: number, cw: number, ch: number) => {
        const cv = document.createElement("canvas");
        cv.width = cw;
        cv.height = ch;
        const g = cv.getContext("2d")!;
        g.imageSmoothingQuality = "high";
        g.drawImage(im, sx, sy, sw, sh, 0, 0, cw, ch);
        return g.getImageData(0, 0, cw, ch).data;
      };
      // the export one shrunk pixel larger on each side, so every pixel of the card has its eight neighbours
      const p = px(a, 0, 0, a.naturalWidth, a.naturalHeight, W, H),
        q = px(b, x - w / W, y - h / H, w + (2 * w) / W, h + (2 * h) / H, W + 2, H + 2);
      let off = 0;
      for (let j = 0; j < H; j++)
        for (let i = 0; i < W; i++) {
          const k = (j * W + i) * 4;
          let best = 255;
          for (let dy = 0; dy <= 2; dy++)
            for (let dx = 0; dx <= 2; dx++) {
              const m = ((j + dy) * (W + 2) + i + dx) * 4;
              best = Math.min(
                best,
                Math.max(Math.abs(p[k] - q[m]), Math.abs(p[k + 1] - q[m + 1]), Math.abs(p[k + 2] - q[m + 2])),
              );
            }
          if (best > 48) off++;
        }
      return off / (W * H);
    },
    [shot, png, crop] as const,
  );
}

test("pngExportLooksLikeBoard", async () => {
  for (const theme of ["warm-ink", "ink-wash"]) {
    const b = board();
    const h = await open({ board: b, light: true, w: 1100, h: 700, scale: 2, settings: { theme } as never });
    const pg = h.page;
    await pg.evaluate(() => document.fonts.ready);
    await idle(h);
    // the board's own picture of each card, and where the card is in world coordinates
    const cards: { id: string; shot: string; world: { x: number; y: number; w: number; h: number } }[] = [];
    for (const id of ["n1", "f1"]) {
      const el = pg.locator(`.card[data-id="${id}"]`);
      const buf = await el.screenshot({ animations: "disabled" });
      fs.writeFileSync(path.join(OUT, `png-export-${theme}-${id}-board.png`), buf);
      const shot = `data:image/png;base64,${buf.toString("base64")}`;
      const world = await el.evaluate((e) => {
        const s = (e as HTMLElement).style;
        return { x: parseFloat(s.left), y: parseFloat(s.top), w: e.offsetWidth, h: e.offsetHeight };
      });
      cards.push({ id, shot, world });
    }
    await pg.locator('.bbar [aria-label="More"]').click();
    await pg.locator(".ctx:not(.closing) button", { hasText: "Export…" }).click();
    await pg.locator(".xdlg").waitFor();
    await pg.locator(".xdlg .seg button", { hasText: "PNG" }).click();
    await pg.locator(".xdlg button.def").click();
    const png = await until(
      h,
      `the ${theme} PNG is sent`,
      () => (h.sent.find((m) => m.type === "exportPng") as { dataUrl: string } | undefined)?.dataUrl,
      20000,
    );
    fs.writeFileSync(path.join(OUT, `png-export-${theme}.png`), Buffer.from(png.replace(/^data:[^,]*,/, ""), "base64"));
    // the export: the cards' and Sections' bounds, 40 px around them, at twice the size
    const x0 = Math.min(...cards.map((c) => c.world.x)) - 40,
      y0 = Math.min(...cards.map((c) => c.world.y)) - 40;
    for (const c of cards) {
      const d = await cardDiff(pg, c.shot, png, [
        (c.world.x - x0) * 2,
        (c.world.y - y0) * 2,
        c.world.w * 2,
        c.world.h * 2,
      ]);
      check(`pngExportLooksLikeBoard ${theme} ${c.id}`, d < 0.004, { diff: d.toFixed(4) });
    }
    await h.close();
  }
});
