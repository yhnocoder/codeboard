// Notes whose header folds away while editing: npm run harness -- noteTextStaysPutLeavingEdit
import { emptyBoard, type NoteCard } from "@codeboard/core";
import { put } from "../harness";
import { test, open, check, idle } from "../fixtures";
/** Leaving edit on a Note whose header folded away: the text below the heading stays where it was on every frame (the shown heading
 *  can be a little taller or shorter than the editor's) */
test("noteTextStaysPutLeavingEdit", async () => {
  for (const theme of ["soft-light", "warm-ink"]) {
  const b = emptyBoard("b1", "p");
  put(b, { id: "n0", kind: "note", md: "# 列：彩色图像转灰度\n\n![](data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSIzMDAiIGhlaWdodD0iMTIwIj48cmVjdCB3aWR0aD0iMzAwIiBoZWlnaHQ9IjEyMCIgZmlsbD0iI2M4NCIvPjwvc3ZnPg==)\n\n该图是由许多像素组成的彩色图像，每个像素包含红、绿、蓝三个分数值 $(r, g, b)$，要计算亮度值 $L$:\n\n$$L = r \\times 0.299 + g$$\n\n第二段。", bg: true } as NoteCard, 60, 60, 380); (b.place.n0 as any).h = 260; b.cam = { x: 0, y: 0, z: 1 };
  const h = await open({ board: b, light: true, w: 900, h: 500, settings: { theme } as never });
  const pg = h.page;
  await pg.locator('.card[data-id="n0"] .nbody img').evaluate((e) => (e as HTMLImageElement).decode()); await idle(h);
  await pg.locator('.card[data-id="n0"] .nbody p').last().dblclick();
  await pg.waitForSelector('.card[data-id="n0"] .md-pm'); await idle(h); // the editor is open, the header folded away
  await pg.evaluate(() => { const w = window as any; w.__y = []; const card = document.querySelector('.card[data-id="n0"]')!; const t0 = performance.now();
    const f = () => { const ps = card.querySelectorAll(".nbody p"); const p = ps[ps.length - 1] as HTMLElement | undefined; const z = card.getBoundingClientRect().width / (card as HTMLElement).offsetWidth; const im = card.querySelector(".nbody img") as HTMLElement | null; w.__y.push([Math.round(performance.now() - t0), p ? +((p.getBoundingClientRect().top - card.getBoundingClientRect().top) / z).toFixed(1) : null, card.querySelector(".md-pm") ? "ed" : "st", im ? +((im.getBoundingClientRect().top - card.getBoundingClientRect().top) / z).toFixed(1) : null, +z.toFixed(3)]); if (performance.now() - t0 < 500) requestAnimationFrame(f); else w.__yDone = true; }; requestAnimationFrame(f); });
  await pg.mouse.click(860, 480);
  await pg.waitForFunction(() => (window as any).__yDone); // every frame of the 500 ms after the click is recorded
  const ys = (await pg.evaluate(() => (window as any).__y)) as [number, number | null, string, number | null, number][];
  const tops = ys.map((y) => y[1]).filter((y): y is number => y !== null);
  check(`noteTextStaysPutLeavingEdit-${theme}`, tops.length > 10 && Math.max(...tops) - Math.min(...tops) <= 0.5, ys);
  await pg.context().close();
  }
});
