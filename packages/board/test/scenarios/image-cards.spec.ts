// Image cards follow their image's aspect ratio: no blank bands beside or above the picture, after loading and after a resize.
// Usage: npm run harness -- imageFollowsAspectRatio
// Screenshots: test-out/harness/image-*.png (HARNESS_LIGHT=1 for the light theme)
import * as path from "node:path";
import { OUT, type Host } from "../harness";
import { emptyBoard, migrateBoard, type Board } from "@codeboard/core";
import { test, open, check, light } from "../fixtures";

const svg = (w: number, hgt: number, fill: string) => "data:image/svg+xml," + encodeURIComponent(
  `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${hgt}"><rect width="${w}" height="${hgt}" fill="${fill}"/><circle cx="${w / 2}" cy="${hgt / 2}" r="${Math.min(w, hgt) / 3}" fill="#fff8"/></svg>`);

/** How the picture sits in the card: the img box against the body box, and the box's ratio against the image's own */
const fit = (h: Host, id: string) => h.page.evaluate((id) => {
  const img = document.querySelector<HTMLImageElement>(`.card[data-id="${id}"] .imgb img`)!, body = img.parentElement!;
  const a = img.getBoundingClientRect(), b = body.getBoundingClientRect();
  return { img: { w: a.width, h: a.height }, body: { w: b.width, h: b.height }, natural: img.naturalWidth / img.naturalHeight, shown: a.width / a.height };
}, id);
const noBands = (f: Awaited<ReturnType<typeof fit>>) => Math.abs(f.img.w - f.body.w) <= 1 && Math.abs(f.img.h - f.body.h) <= 1 && Math.abs(f.shown - f.natural) < 0.02;

test("imageFollowsAspectRatio", async () => {
  const b: Board = emptyBoard("b1", "images");
  b.cards.push({ id: "wide", kind: "image", src: svg(400, 200, "#e8a33d") } as any, { id: "tall", kind: "image", src: svg(200, 400, "#3d7be8"), desc: "A caption below the picture" } as any);
  // a stored height that disagrees with the image (older boards, the old corner resize)
  b.place.wide = { x: 60, y: 80, w: 360, h: 360 };
  b.place.tall = { x: 520, y: 80, w: 240, h: 200 };
  b.cam = { x: 0, y: 0, z: 1 };
  const h = await open({ board: migrateBoard(JSON.parse(JSON.stringify({ ...b, version: 6 }))), light, w: 1000, h: 800 });
  const pg = h.page;
  await pg.waitForTimeout(1200);
  await pg.screenshot({ path: path.join(OUT, "image-29-aspect.png"), clip: { x: 20, y: 40, width: 800, height: 620 } });
  const wide = await fit(h, "wide"), tall = await fit(h, "tall");
  check("imageFollowsAspectRatio wide image, no bands", noBands(wide), wide);
  check("imageFollowsAspectRatio tall image with caption, no bands", noBands(tall), tall);
  const desc = await pg.locator('.card[data-id="tall"] .cdesc').evaluate((e) => { const r = e.getBoundingClientRect(), c = e.closest(".card")!.getBoundingClientRect(); return { top: r.top, bottom: r.bottom, card: c.bottom, text: e.textContent }; });
  check("imageFollowsAspectRatio caption under the picture", desc.text === "A caption below the picture" && desc.bottom <= desc.card + 0.5, desc);

  // corner resize: the width leads, the height follows the image
  await pg.locator('.card[data-id="wide"]').hover();
  const g = (await pg.locator('.card[data-id="wide"] .grip').boundingBox())!;
  await pg.mouse.move(g.x + g.width / 2, g.y + g.height / 2);
  await pg.mouse.down();
  for (let i = 1; i <= 10; i++) { await pg.mouse.move(g.x + g.width / 2 + i * 8, g.y + g.height / 2 + i * 20); await pg.waitForTimeout(20); }
  const during = await fit(h, "wide");
  await pg.mouse.up();
  await pg.waitForTimeout(1300);
  const after = await fit(h, "wide");
  await pg.screenshot({ path: path.join(OUT, "image-29-aspect-resized.png"), clip: { x: 20, y: 40, width: 800, height: 620 } });
  const p = h.board().place.wide;
  check("imageFollowsAspectRatio resize keeps the ratio", noBands(during) && noBands(after) && p.w > 360 && p.h === undefined, { during, after, p });
});
