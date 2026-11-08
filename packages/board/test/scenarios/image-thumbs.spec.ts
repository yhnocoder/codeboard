// Image cards of big pictures show the host's smaller copy (host/src/thumbs, picked as Note images are: md/copies.ts) at the zoom they are seen at, and
// the original once zoomed in far enough that the copy would blur. The copies go in the editor's storage, never into the boards'
// folder; an Image card far off screen has its picture loaded before the camera comes (no loading="lazy": inside the board's
// transformed world a zoom out or a fast pan brought it into view before it loaded), drawn only once decoded
import * as fs from "node:fs";
import * as path from "node:path";
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
    const i = document.querySelector<HTMLImageElement>(`.card[data-id="${id}"] .imgb img`);
    if (!i) return null;
    const r = i.getBoundingClientRect();
    return {
      src: i.getAttribute("src") ?? "",
      natural: i.naturalWidth,
      loaded: i.complete && i.naturalWidth > 0,
      decoding: i.decoding,
      loading: i.loading,
      dataW: i.dataset.w,
      ratio: r.width / r.height,
    };
  }, id);
const zoom = (h: Host) =>
  h.page.evaluate(() => new DOMMatrix(getComputedStyle(document.querySelector(".world")!).transform).a);

test("imageCardThumbnail", async () => {
  const b: Board = emptyBoard("b1", "images");
  b.cards.push(
    { id: "big", kind: "image", src: "big.png" } as Board["cards"][number],
    { id: "far", kind: "image", src: "far.png" } as Board["cards"][number],
  );
  b.place.big = { x: 100, y: 80, w: 600 };
  b.place.far = { x: 9000, y: 80, w: 400 };
  b.cam = { x: 0, y: 0, z: 1 };
  const run = await hostBoards([b], { page: { light: true, w: 1100, h: 760, settings: { theme: "warm-ink" } } });
  const assets = run.host.store.assetsDir();
  fs.mkdirSync(assets, { recursive: true });
  fs.writeFileSync(path.join(assets, "big.png"), shot(3000, 2000));
  fs.writeFileSync(path.join(assets, "far.png"), shot(2000, 1000));
  const h = await run.open(b.id);
  const pg = h.page;

  // 600 px at 100% on a 1x screen: the 800 px copy, which keeps the original's ratio and reports the original's width
  const small = await until(h, "the big image shows", async () => {
    const i = await imgOf(h, "big");
    return i?.loaded ? i : null;
  });
  check(
    "imageCardThumbnail a smaller copy at 100%",
    small.natural === 800 && /\/thumbs\/[0-9a-f]+-800\.png$/.test(small.src),
    small,
  );
  check("imageCardThumbnail keeps the original's ratio", Math.abs(small.ratio - 1.5) < 0.01, small);
  check("imageCardThumbnail knows the original's width (Fit Content)", small.dataW === "3000", small);
  check(
    "imageCardThumbnail loads at once and is drawn only decoded",
    small.decoding === "sync" && small.loading !== "lazy",
    small,
  );
  // far off screen: loaded all the same, before the camera comes
  const far = await until(h, "the far image loads", async () => {
    const i = await imgOf(h, "far");
    return i?.loaded ? i : null;
  });
  check("imageCardThumbnail an image far off screen is loaded before it is in view", far.loaded, far);
  await pg.screenshot({ path: path.join(OUT, "image-thumb-100.png") });

  // the copies are a cache in the editor's storage: the boards' folder holds the board and its two pictures, nothing else
  const thumbs = path.join(run.ws.storage.dir(), "thumbs");
  check(
    "imageCardThumbnail the copy is in the editor's storage",
    fs.readdirSync(thumbs).some((f) => f.endsWith("-800.png")),
    fs.readdirSync(thumbs),
  );
  check(
    "imageCardThumbnail nothing new in assets/",
    fs.readdirSync(assets).sort().join() === "big.png,far.png",
    fs.readdirSync(assets),
  );

  // zoomed in to 250%: 1500 px shown, past the largest copy (1600 px with headroom): the original, once the camera stops
  const box = await pg.locator('.card[data-id="big"] .imgb').boundingBox();
  await pg.mouse.move(box!.x + 40, box!.y + 40);
  await pg.keyboard.down("ControlOrMeta");
  for (let i = 0; i < 12 && (await zoom(h)) < 2.4; i++) await pg.mouse.wheel(0, -120);
  await pg.keyboard.up("ControlOrMeta");
  await until(h, "zoomed in to 250%", async () => (await zoom(h)) > 2.4);
  const full = await until(h, "the original shows", async () => {
    const i = await imgOf(h, "big");
    return i?.loaded && i.natural === 3000 ? i : null;
  });
  check("imageCardThumbnail the original when zoomed in", /\/assets\/big\.png$/.test(full.src), full);
  check("imageCardThumbnail same ratio after the swap", Math.abs(full.ratio - 1.5) < 0.01, full);
  await idle(h);
  await pg.screenshot({ path: path.join(OUT, "image-thumb-250.png") });

  // the camera comes to the far card: its picture is the source for the zoom it is seen at, a copy of the 2000 px picture (400 or
  // 800; none at 1600, too close to its own width) or the original past that; a copy loaded before at a larger zoom stays
  await h.post({ type: "reveal", card: "far" });
  await idle(h);
  const z = await zoom(h),
    seen = 400 * z * 1.15;
  const want = seen <= 400 ? 400 : seen <= 800 ? 800 : 2000;
  const near = await until(h, "the far image shows the source for the zoom", async () => {
    const i = await imgOf(h, "far");
    return i?.loaded && i.natural >= want ? i : null;
  });
  check(
    "imageCardThumbnail the far image, in view, is sized to the zoom",
    (near.natural === want || (near.natural === 800 && want === 400)) &&
      (near.natural === 2000 ? /\/assets\/far\.png$/.test(near.src) : near.src.includes("/thumbs/")),
    { ...near, z },
  );
});
