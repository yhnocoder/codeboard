// Bitmap and animated stickers from a folder pack (PNG, APNG, GIF, animated WebP): drawn as <img>, animated ones play only on screen
// at full detail and in the picker under the pointer (npm run harness -- stickerBitmapsAnimate stickerBitmapsPicker)
import { shot, symCard, findSym, put } from "../harness";
import { cornerAt, emptyBoard, type Board, type StickerPack } from "@codeboard/core";
import { animWebp, apng, faceFrames, gif, png, type Paint, type Rgba } from "@codeboard/host/test/images";
import type { Browser, Page } from "@playwright/test";
import { test, open, check, light } from "../fixtures";

const YELLOW: Rgba = [244, 192, 64, 255], PINK: Rgba = [236, 120, 160, 255], BLUE: Rgba = [96, 150, 236, 255];
const toGif = (size: number, frames: Paint[]) => {
  // palette 0 = transparent, 1 = face, 2 = features
  const idx = (f: Paint) => (x: number, y: number) => { const c = f(x, y); return c[3] === 0 ? 0 : c[0] === 60 ? 2 : 1; };
  return gif(size, size, [[0, 0, 0], [PINK[0], PINK[1], PINK[2]], [60, 40, 30]], frames.map(idx), 200, 0);
};
const uri = (mime: string, b: Buffer) => `data:${mime};base64,${b.toString("base64")}`;

/** Two static WebP frames from Chromium's canvas (a bouncing ball), put together as an animated WebP */
async function webpFrames(browser: Browser, size: number) {
  const page = await browser.newPage();
  const frames = await page.evaluate((n) => [0, 1].map((k) => {
    const c = document.createElement("canvas"); c.width = c.height = n;
    const g = c.getContext("2d")!;
    g.fillStyle = "#5b8def"; g.beginPath(); g.arc(n / 2, k ? n * 0.3 : n * 0.66, n * 0.28, 0, Math.PI * 2); g.fill();
    g.fillStyle = "#fff"; g.font = `bold ${n * 0.28}px sans-serif`; g.textAlign = "center"; g.textBaseline = "middle"; g.fillText(k ? "↑" : "↓", n / 2, k ? n * 0.3 : n * 0.66);
    return c.toDataURL("image/webp", 0.9).split(",")[1];
  }), size);
  await page.close();
  return animWebp(size, size, frames.map((f) => Buffer.from(f, "base64")));
}

async function party(browser: Browser): Promise<StickerPack> {
  const banner: Paint = (x, y) => (y < 4 || y > 19 ? [0, 0, 0, 0] : x < 24 ? YELLOW : BLUE);
  return {
    id: "Party", name: "Party", icons: [
      { name: "smile", img: uri("image/png", png(64, 64, faceFrames(64, YELLOW)[0])) },
      { name: "banner", img: uri("image/png", png(48, 24, banner)) },
      { name: "wink", img: uri("image/gif", toGif(64, faceFrames(64, PINK))), anim: true },
      { name: "bounce", img: uri("image/webp", await webpFrames(browser, 64)), anim: true },
      { name: "blink", img: uri("image/png", apng(64, 64, faceFrames(64, BLUE))), anim: true },
    ],
  };
}

const ANIM = ["k3", "k4", "k5", "k8", "k9"];
function board(): Board {
  const b = emptyBoard("b1", "stickers");
  const s = findSym("Scheduler.schedule"), c = symCard(s.f, s.s);
  put(b, c, 80, 200, 560);
  const icon = (name: string) => ({ pack: "Party", name });
  b.stickers.push(
    { id: "k1", icon: icon("smile"), at: { kind: "canvas", x: 80, y: 60, size: 64 } },
    { id: "k2", icon: icon("banner"), at: { kind: "canvas", x: 170, y: 60, size: 64 } },
    { id: "k3", icon: icon("wink"), at: { kind: "canvas", x: 260, y: 60, size: 64 } },
    { id: "k4", icon: icon("bounce"), at: { kind: "canvas", x: 350, y: 56, size: 72 } },
    { id: "k5", icon: icon("blink"), at: { kind: "canvas", x: 450, y: 60, size: 64 } },
    { id: "k6", icon: { pack: "builtin", name: "star" }, at: { kind: "canvas", x: 540, y: 76, size: 36 } },
    // far off screen to the right
    { id: "k7", icon: icon("wink"), at: { kind: "canvas", x: 6000, y: 60, size: 64 } },
    // on the card's corner and on a code line
    { id: "k8", icon: icon("wink"), at: { kind: "canvas", ...cornerAt(560), on: { card: c.id } } },
    { id: "k9", icon: icon("bounce"), at: { kind: "line", card: c.id, seg: c.segments[0].id, line: c.segments[0].start + 2 } },
  );
  b.cam = { x: 0, y: 0, z: 1 };
  return b;
}

type ImgState = { src: string; anim: boolean; paused: boolean; w: number; h: number; nat: number; fit: string };
const imgs = (page: Page) => page.evaluate(() => Object.fromEntries([...document.querySelectorAll<HTMLImageElement>("[data-sticker] img.glyph.img")].map((im) => {
  const r = im.getBoundingClientRect();
  return [im.closest<HTMLElement>("[data-sticker]")!.dataset.sticker!, { src: im.getAttribute("src") ?? "", anim: im.classList.contains("anim"), paused: im.classList.contains("paused"), w: Math.round(r.width), h: Math.round(r.height), nat: im.naturalWidth, fit: getComputedStyle(im).objectFit }];
})) as Record<string, ImgState>);
/** Screenshots of one element a few times over 600 ms (the frames are 200 ms): how many different pictures */
async function pictures(page: Page, sel: string) {
  const seen = new Set<string>();
  for (let i = 0; i < 6; i++) { seen.add((await page.locator(sel).screenshot()).toString("base64")); await page.waitForTimeout(110); }
  return seen.size;
}
const zoom = async (page: Page, dy: number, until: () => Promise<boolean>) => {
  await page.mouse.move(900, 80);
  await page.keyboard.down("Control");
  for (let i = 0; i < 30 && !(await until()); i++) { await page.mouse.wheel(0, dy); await page.waitForTimeout(60); }
  await page.keyboard.up("Control");
  await page.waitForTimeout(300);
};

test("stickerBitmapsAnimate", async ({ browser }) => {
  const pack = await party(browser);
  const orig = Object.fromEntries(pack.icons.map((i) => [i.name, "img" in i ? i.img : ""]));
  const b = board();
  const nameOf = (id: string) => b.stickers.find((s) => s.id === id)!.icon.name;
  const h = await open({ board: b, light, w: 1000, h: 640, on: (m, reply) => (m.type === "stickerPacks" ? (void reply(m.req!, [pack]), true) : false) });
  await h.page.waitForFunction(() => [...document.querySelectorAll<HTMLImageElement>("img.glyph.img")].filter((i) => i.complete && i.naturalWidth > 0).length >= 8);
  await h.page.waitForTimeout(300);
  let st = await imgs(h.page);

  // Every bitmap sticker is a decoded <img> in a square box, scaled with its aspect ratio kept
  const want = ["k1", "k2", "k3", "k4", "k5", "k7", "k8", "k9"];
  check("sticker-bitmap-img", want.every((k) => st[k]?.nat > 0 && st[k].w === st[k].h && st[k].fit === "contain"), JSON.stringify(Object.fromEntries(Object.entries(st).map(([k, v]) => [k, { ...v, src: v.src.slice(0, 30) }]))));
  check("sticker-bitmap-static", !st.k1.anim && !st.k2.anim && st.k1.src === orig.smile && st.k2.src === orig.banner);

  // On screen at full detail the animated ones play their own image, and it really changes; the one far off screen shows its first frame only
  const onPlay = ANIM.every((k) => !st[k].paused && st[k].src === orig[nameOf(k)]);
  check("sticker-anim-onscreen-plays", onPlay, JSON.stringify(ANIM.map((k) => [k, st[k].paused, st[k].src.slice(0, 22)])));
  const moving = { gif: await pictures(h.page, '[data-sticker="k3"] img'), webp: await pictures(h.page, '[data-sticker="k4"] img'), apng: await pictures(h.page, '[data-sticker="k5"] img') };
  check("sticker-anim-frames-change", moving.gif > 1 && moving.webp > 1 && moving.apng > 1, JSON.stringify(moving));
  check("sticker-anim-offscreen-paused", st.k7.paused && st.k7.src.startsWith("data:image/png;") && st.k7.src !== orig.wink, JSON.stringify({ ...st.k7, src: st.k7.src.slice(0, 30) }));
  await shot(h, "stickers-bitmap-board");

  // Zoomed out to the overview: every animated sticker stops on its first frame
  await zoom(h.page, 40, () => h.page.evaluate(() => document.getElementById("board")!.classList.contains("lod-overview")));
  st = await imgs(h.page);
  const still = await pictures(h.page, '[data-sticker="k3"] img');
  check("sticker-anim-paused-zoomed-out", ANIM.every((k) => st[k].paused && st[k].src.startsWith("data:image/png;") && st[k].src !== orig[nameOf(k)]) && still === 1, JSON.stringify({ still, paused: ANIM.map((k) => [k, st[k].paused]) }));
  await shot(h, "stickers-bitmap-overview");

  // Back to full detail: they play again
  await zoom(h.page, -40, () => h.page.evaluate(() => !document.getElementById("board")!.className.includes("lod-")));
  st = await imgs(h.page);
  check("sticker-anim-resumes", ANIM.every((k) => !st[k].paused && st[k].src === orig[nameOf(k)]), JSON.stringify(ANIM.map((k) => [k, st[k].paused])));

  // Panned so the far one is on screen: it plays, and the ones now far away stop
  await h.page.mouse.move(900, 80) // empty canvas, not over the card;
  const k7x = async () => (await h.page.locator('[data-sticker="k7"]').boundingBox())?.x ?? 1e9;
  for (let i = 0; i < 80 && (await k7x()) > 500; i++) { await h.page.mouse.wheel(Math.min(400, (await k7x()) - 450), 0); await h.page.waitForTimeout(30); }
  await h.page.waitForTimeout(400);
  const after = await imgs(h.page);
  const k7 = await h.page.locator('[data-sticker="k7"]').boundingBox();
  if (k7 && k7.x > 0 && k7.x < 1000) check("sticker-anim-panned-in-plays", !after.k7.paused && after.k7.src === orig.wink && after.k3.paused, JSON.stringify({ k7, k7p: after.k7.paused, k3p: after.k3.paused }));
  else check("sticker-anim-panned-in-plays", false, "k7 not brought on screen", JSON.stringify(k7));
});

test("stickerBitmapsPicker", async ({ browser }) => {
  const pack = await party(browser);
  const h = await open({ board: emptyBoard("b1", "picker"), light, w: 1000, h: 640, on: (m, reply) => (m.type === "stickerPacks" ? (void reply(m.req!, [pack]), true) : false) });
  await h.page.locator('.bbar button[aria-label="Sticker"]').click();
  await h.page.locator(".stkpick .stabs button", { hasText: "Party" }).click();
  await h.page.waitForFunction(() => document.querySelectorAll(".stkpick img.glyph.img").length === 5);
  await h.page.waitForTimeout(300);
  const cells = () => h.page.evaluate(() => [...document.querySelectorAll<HTMLImageElement>(".stkpick img.glyph.img")].map((im) => ({ name: im.dataset.name, anim: im.classList.contains("anim"), paused: im.classList.contains("paused"), nat: im.naturalWidth })));
  const before = await cells();
  const colors = await h.page.locator(".stkpick .scolors").count();
  check("sticker-picker-bitmaps", before.every((c) => c.nat > 0) && before.filter((c) => c.anim).every((c) => c.paused) && !colors, JSON.stringify({ before, colors }));
  await h.page.locator('.stkpick .scell[data-tip="wink"]').hover();
  await h.page.waitForTimeout(250);
  const hov = await cells();
  check("sticker-picker-anim-on-hover", hov.find((c) => c.name === "wink")?.paused === false && hov.filter((c) => c.anim && c.name !== "wink").every((c) => c.paused), JSON.stringify(hov));
  await shot(h, "stickers-bitmap-picker");
});
