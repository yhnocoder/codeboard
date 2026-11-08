// Renders each recorded board (site/data) into map-style tile pyramids with the real board in headless Chromium:
// tiles-out/<id>/manifest.json and <level>/<col>_<row>.jpg. Usage: node tiles.mjs [board id …]  (site/ served on :8765)
import * as fs from "node:fs";
import * as path from "node:path";
import { launch } from "../../tools/test/chromium.mjs";

const OUT = path.resolve("tiles-out");
const DPR = +(process.env.DPR ?? 2);
const TILE = 512; // image px
const CSS_TILE = TILE / DPR;
const V = CSS_TILE * 4; // viewport edge in CSS px: one shot = 4×4 tiles
const Q = +(process.env.Q ?? 80);
const ids = process.argv.slice(2);

const metas = JSON.parse(fs.readFileSync("site/data/index.json", "utf8"));
fs.mkdirSync(OUT, { recursive: true });
fs.writeFileSync(path.join(OUT, "index.json"), JSON.stringify(metas));
const browser = await launch();
const ctx = await browser.newContext({ viewport: { width: V, height: V }, deviceScaleFactor: DPR });
const page = await ctx.newPage();
page.on("pageerror", (e) => console.error("page:", e.message));
await page.goto("http://localhost:8765/render.html");
await page.waitForFunction(() => window.__ready);

const settle = async () => {
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(250);
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
};
const cam = () =>
  page.evaluate(() => {
    const m = /translate\(([-\d.e]+)px, ([-\d.e]+)px\) scale\(([\d.e-]+)\)/.exec(document.querySelector("#board .world")?.style.transform ?? "");
    return m ? { x: +m[1], y: +m[2], z: +m[3] } : null;
  });
async function show(id, c, exact = true) {
  await page.evaluate(([id, c]) => window.__show(id, c), [id, c]);
  await page.waitForFunction(
    ([z]) => {
      const w = document.querySelector("#board .world");
      return w && w.querySelector(".card") && (!z || new RegExp(`scale\\(${z}\\)`).test(w.style.transform));
    },
    [exact ? c.z : 0],
    { timeout: 20000 },
  );
  await settle();
}
async function panTo(x, y) {
  const now = await cam();
  await page.evaluate(
    ([dx, dy]) =>
      document.getElementById("board").dispatchEvent(new WheelEvent("wheel", { bubbles: true, cancelable: true, deltaX: dx, deltaY: dy, clientX: 10, clientY: 10 })),
    [now.x - x, now.y - y],
  );
  await settle();
  const c = await cam();
  if (Math.abs(c.x - x) > 0.5 || Math.abs(c.y - y) > 0.5) throw new Error(`camera at ${JSON.stringify(c)}, wanted ${x},${y}`);
}

for (const m of metas) {
  if (ids.length && !ids.includes(m.id)) continue;
  const t0 = Date.now();
  const dir = path.join(OUT, m.id);
  fs.rmSync(dir, { recursive: true, force: true });
  await show(m.id, { x: 0, y: 0, z: 1 });
  // what the board covers, in world px, and where its sub-board cards are
  let geo = await page.evaluate(() => {
    const w = document.querySelector("#board .world");
    const m = /translate\(([-\d.e]+)px, ([-\d.e]+)px\) scale\(([\d.e-]+)\)/.exec(w.style.transform);
    const [tx, ty, z] = [+m[1], +m[2], +m[3]];
    const boardRect = document.getElementById("board").getBoundingClientRect();
    const toW = (r) => ({ x: (r.left - boardRect.left - tx) / z, y: (r.top - boardRect.top - ty) / z, w: r.width / z, h: r.height / z });
    let l = Infinity, t = Infinity, r = -Infinity, b = -Infinity;
    for (const el of w.querySelectorAll(".card, .sect, [data-sect]")) {
      const q = toW(el.getBoundingClientRect());
      if (!q.w || !q.h) continue;
      l = Math.min(l, q.x); t = Math.min(t, q.y); r = Math.max(r, q.x + q.w); b = Math.max(b, q.y + q.h);
    }
    const boards = [...w.querySelectorAll(".card.board")].map((el) => ({ id: el.dataset.id, rect: toW(el.getBoundingClientRect()) }));
    const bg = getComputedStyle(document.getElementById("board")).backgroundColor;
    return { l, t, r, b, boards, bg };
  });
  const board = (await page.evaluate(() => window.__msgs.find((x) => x.type === "init").board));
  // the zoomed-out summaries can reach past the cards: measured too, at the smallest level's zoom
  await show(m.id, { x: 0, y: 0, z: 0.05 }, false);
  await page.waitForTimeout(800);
  const sum = await page.evaluate(() => {
    const w = document.querySelector("#board .world");
    const m = /translate\(([-\d.e]+)px, ([-\d.e]+)px\) scale\(([\d.e-]+)\)/.exec(w.style.transform);
    const [tx, ty, z] = [+m[1], +m[2], +m[3]];
    const br = document.getElementById("board").getBoundingClientRect();
    let l = Infinity, t = Infinity, r = -Infinity, b = -Infinity;
    for (const el of w.querySelectorAll(".sumblk, .sumcol")) {
      const q = el.getBoundingClientRect();
      if (!q.width || !q.height) continue;
      l = Math.min(l, (q.left - br.left - tx) / z); t = Math.min(t, (q.top - br.top - ty) / z);
      r = Math.max(r, (q.right - br.left - tx) / z); b = Math.max(b, (q.bottom - br.top - ty) / z);
    }
    return { l, t, r, b };
  });
  if (Number.isFinite(sum.l)) {
    geo.l = Math.min(geo.l, sum.l); geo.t = Math.min(geo.t, sum.t); geo.r = Math.max(geo.r, sum.r); geo.b = Math.max(geo.b, sum.b);
  }
  const pad = 60;
  const world = { x: Math.floor(geo.l - pad), y: Math.floor(geo.t - pad), w: Math.ceil(geo.r - geo.l + 2 * pad), h: Math.ceil(geo.b - geo.t + 2 * pad) };
  const hits = geo.boards
    .map((h) => ({ rect: h.rect, board: board.cards.find((c) => c.id === h.id)?.board }))
    .filter((h) => h.board);
  const levels = [];
  for (let z = 1; ; z /= 2) {
    levels.push({ z, cols: Math.ceil((world.w * z * DPR) / TILE), rows: Math.ceil((world.h * z * DPR) / TILE) });
    if (world.w * z * DPR <= TILE * 2 && world.h * z * DPR <= TILE * 2) break;
  }
  let n = 0;
  for (const [i, L] of [...levels.entries()]) {
    fs.mkdirSync(path.join(dir, String(i)), { recursive: true });
    const span = V / L.z; // world px per shot
    await show(m.id, { x: -world.x * L.z, y: -world.y * L.z, z: L.z }, false);
    await page.waitForTimeout(500);
    // the board's minimum zoom (its summaries' own): no levels below it, the app scales the last one down
    if (Math.abs((await cam()).z - L.z) > 1e-6) {
      levels.length = i;
      break;
    }
    for (let sy = 0; sy < L.rows; sy += 4)
      for (let sx = 0; sx < L.cols; sx += 4) {
        await panTo(-(world.x + (sx * CSS_TILE) / L.z) * L.z, -(world.y + (sy * CSS_TILE) / L.z) * L.z);
        for (let ty = sy; ty < Math.min(L.rows, sy + 4); ty++)
          for (let tx = sx; tx < Math.min(L.cols, sx + 4); tx++) {
            const x = (tx - sx) * CSS_TILE, y = (ty - sy) * CSS_TILE;
            const w = Math.min(CSS_TILE, world.w * L.z - tx * CSS_TILE), h = Math.min(CSS_TILE, world.h * L.z - ty * CSS_TILE);
            await page.screenshot({ path: path.join(dir, String(i), `${tx}_${ty}.jpg`), type: "jpeg", quality: Q, clip: { x, y, width: w, height: h } });
            n++;
          }
      }
    void span;
  }
  const rgb = /\d+/g;
  const [r, g, b] = (geo.bg.match(rgb) ?? [239, 235, 228]).map(Number);
  const bg = `#${[r, g, b].map((v) => v.toString(16).padStart(2, "0")).join("")}`;
  fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify({ id: m.id, name: m.name, world, tile: TILE, dpr: DPR, levels, bg, hits }, null, 1));
  console.log(m.id, m.name, `${n} tiles`, `${levels.length} levels`, `${((Date.now() - t0) / 1000).toFixed(0)} s`);
}
await browser.close();
