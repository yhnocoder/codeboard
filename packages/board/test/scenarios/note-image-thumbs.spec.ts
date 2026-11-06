// A big screenshot in a Note shows the host's smaller copy sized to the zoom it is seen at, as an Image card does (one picker:
// @yhnocoder/markdown's picture.ts, the copies from md/copies.ts), and the original once zoomed in far enough that the largest
// copy would blur. Only the display changes: the Note's Markdown keeps assets/…, the <img> carries it as data-src. A board opened
// once its copies exist gets them with init and never loads the original at 100%
import * as fs from "node:fs";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { emptyBoard, type Board } from "@codeboard/core";
import { png } from "@codeboard/host/testing";
import { OUT, type Host } from "../harness";
import { test, check, until, idle, hostBoards } from "../fixtures";

/** A screenshot-like picture: a grid and dark text-like rows on paper */
const shot = (w: number, h: number) =>
  png(w, h, (x, y) =>
    x % 50 === 0 || y % 50 === 0
      ? [40, 40, 48, 255]
      : y % 25 > 8 && y % 25 < 15 && x % 100 < 80
        ? [30, 30, 36, 255]
        : [248, 247, 242, 255],
  );

const imgOf = (h: Host, id: string) =>
  h.page.evaluate((id) => {
    const i = document.querySelector<HTMLImageElement>(`.card[data-id="${id}"] .md img`);
    if (!i) return null;
    const r = i.getBoundingClientRect();
    return {
      src: i.getAttribute("src") ?? "",
      md: i.dataset.src,
      full: i.dataset.full,
      natural: i.naturalWidth,
      loaded: i.complete && i.naturalWidth > 0,
      ratio: r.width / r.height,
    };
  }, id);
const zoom = (h: Host) =>
  h.page.evaluate(() => new DOMMatrix(getComputedStyle(document.querySelector(".world")!).transform).a);
/** The images this page loaded from the boards' assets/ folder */
const fromAssets = (h: Host) =>
  h.page.evaluate(() =>
    performance
      .getEntriesByType("resource")
      .map((e) => e.name)
      .filter((n) => n.includes("/assets/")),
  );

test("noteImageThumbnail", async () => {
  const bytes = shot(3000, 2000);
  const file = `${createHash("sha1").update(bytes).digest("hex").slice(0, 16)}-3000x2000.png`;
  const MD = `## Run\n\nThe profile:\n\n![profile](assets/${file})\n\nand what it says.`;
  const board = (id: string) => {
    const b: Board = emptyBoard(id, id);
    b.cards.push({ id: "n1", kind: "note", md: MD, look: "note" } as Board["cards"][number]);
    b.place.n1 = { x: 60, y: 40, w: 680 };
    b.cam = { x: 0, y: 0, z: 1 };
    return b;
  };
  const run = await hostBoards([board("b1"), board("b2")], {
    page: { light: true, w: 1100, h: 760, settings: { theme: "warm-ink" } },
  });
  const assets = run.host.store.assetsDir();
  fs.mkdirSync(assets, { recursive: true });
  fs.writeFileSync(path.join(assets, file), bytes);
  const h = await run.open("b1");
  const pg = h.page;

  // about 650 px wide at 100% on a 1x screen: the 800 px copy (made when first asked), in the original's place and ratio
  const small = await until(h, "the Note's image shows a copy", async () => {
    const i = await imgOf(h, "n1");
    return i?.loaded && i.natural === 800 ? i : null;
  });
  check(
    "noteImageThumbnail a smaller copy at 100%",
    /\/thumbs\/[0-9a-f]{20}-800\.png$/.test(small.src) && Math.abs(small.ratio - 1.5) < 0.01,
    small,
  );
  check(
    "noteImageThumbnail the <img> keeps the Markdown's address and the original's",
    small.md === `assets/${file}` && !!small.full?.endsWith(`/assets/${file}`),
    small,
  );
  await idle(h);
  await pg.screenshot({ path: path.join(OUT, "note-image-thumb-100.png") });

  // zoomed in, once the camera stops: to 160% about 1050 px seen, the 1600 px copy; to 250% about 1630 px, past the largest copy
  // with headroom: the original
  const box = await pg.locator('.card[data-id="n1"] .md img').boundingBox();
  const zoomTo = async (z: number) => {
    await pg.mouse.move(box!.x + 40, box!.y + 40);
    await pg.keyboard.down("ControlOrMeta");
    for (let i = 0; i < 20 && (await zoom(h)) < z; i++) await pg.mouse.wheel(0, -60);
    await pg.keyboard.up("ControlOrMeta");
    await until(h, `zoomed in to ${z * 100}%`, async () => (await zoom(h)) >= z);
  };
  await zoomTo(1.5);
  const mid = await until(h, "the 1600 px copy shows", async () => {
    const i = await imgOf(h, "n1");
    return i?.loaded && i.natural === 1600 ? i : null;
  });
  check("noteImageThumbnail steps up to a larger copy", /-1600\.png$/.test(mid.src), { ...mid, z: await zoom(h) });
  await zoomTo(2.45);
  const full = await until(h, "the original shows", async () => {
    const i = await imgOf(h, "n1");
    return i?.loaded && i.natural === 3000 ? i : null;
  });
  check("noteImageThumbnail the original when zoomed in", full.src.endsWith(`/assets/${file}`), full);
  check("noteImageThumbnail same ratio after the swap", Math.abs(full.ratio - 1.5) < 0.01, full);
  await idle(h);
  await pg.screenshot({ path: path.join(OUT, "note-image-thumb-250.png") });

  // the Note's Markdown is what it was: nothing of the copies is written into it
  const kept = (await run.host.store.load("b1"))?.cards.find((c) => c.id === "n1") as { md?: string } | undefined;
  check("noteImageThumbnail the Note's Markdown is unchanged", kept?.md === MD, kept?.md);
  const live = await pg.evaluate(() => document.querySelector<HTMLElement>('.card[data-id="n1"] .md')?.innerHTML ?? "");
  check("noteImageThumbnail the page shows the Markdown's address", live.includes(`data-src="assets/${file}"`), live);

  // another board with the same picture: its copies come with init, the first source is the copy, the original never loads
  const h2 = await run.open("b2");
  const first = await until(h2, "the second board's image shows", async () => {
    const i = await imgOf(h2, "n1");
    return i?.loaded ? i : null;
  });
  check("noteImageThumbnail copies listed at open: the copy from the first frame", first.natural === 800, first);
  const loaded = await fromAssets(h2);
  check("noteImageThumbnail the original is not loaded at 100%", !loaded.some((n) => n.includes(file)), loaded);
});
