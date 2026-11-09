// The parity check: the same cards drawn by the real web board (packages/board/test/scenarios/parity.spec.ts, Playwright) and by
// the Mac app (`CodeBoard --parity`, Auto.swift), per look and appearance, each at rest and selected, side by side on a sheet
// with a numeric difference per card: the mean colour distance and the share of pixels that differ, over the whole picture
// and over the head band, so progress is a number. Works on a COPY of the boards folder it is given, never the folder itself.
//
//   node apps/macos/parity.mjs --boards ~/Projects/persona/.codeboard --board <id> --cards a,b,c [--themes warm-ink,ink-wash]
//        (--cards takes a Section's or an arrow's id too: its frame / its line's box is pictured and compared the same way)
//        [--out test-out/parity] [--app apps/macos/build/CodeBoard.app] [--web-only | --app-only]
//
// Output: <out>/<theme>-<light|dark>.html (the sheet), <out>/parity.json (the numbers), the crops and heat maps beside them.
import { execFileSync, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { PNG } from "pngjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(here, "../..");
const args = process.argv.slice(2);
const arg = (k, d) => {
  const i = args.indexOf(k);
  return i >= 0 ? args[i + 1] : d;
};
const boards = arg("--boards");
const board = arg("--board");
const cards = (arg("--cards") ?? "").split(",").filter(Boolean);
if (!boards || !board || cards.length === 0) {
  console.error("usage: parity.mjs --boards <.codeboard folder> --board <id> --cards <id,id,…>");
  process.exit(2);
}
const themes = (arg("--themes") ?? "warm-ink,ink-wash").split(",");
const out = path.resolve(arg("--out") ?? path.join(REPO, "test-out/parity"));
const app = path.resolve(arg("--app") ?? path.join(here, "build/CodeBoard.app"));
/** The air around a card in both captures (parity.spec.ts PAD, Auto.swift focus) */
const PAD = 40;
/** Both sides draw at 2× */
const SCALE = 2;
const HEAD = 36;

fs.mkdirSync(out, { recursive: true });
// a copy of the boards folder: neither side writes to the real one
const copy = fs.mkdtempSync(path.join(os.tmpdir(), "cb-parity-"));
fs.cpSync(boards, path.join(copy, ".codeboard"), { recursive: true });
const dir = path.join(copy, ".codeboard");

if (!args.includes("--app-only")) {
  console.log("web: rendering", cards.length, "cards in", themes.join(", "));
  const r = spawnSync("npx", ["playwright", "test", "-c", "packages/board", "-g", "parityWeb"], {
    cwd: REPO,
    stdio: "inherit",
    env: {
      ...process.env,
      PARITY_DIR: dir,
      PARITY_BOARD: board,
      PARITY_CARDS: cards.join(","),
      PARITY_OUT: out,
      PARITY_THEMES: themes.join(","),
    },
  });
  if (r.status !== 0) process.exit(r.status ?? 1);
}
if (!args.includes("--web-only")) {
  for (const theme of themes)
    for (const light of ["light", "dark"]) {
      const dest = path.join(out, `app-${theme}-${light}`);
      fs.rmSync(dest, { recursive: true, force: true });
      console.log("app:", theme, light);
      execFileSync(
        path.join(app, "Contents/MacOS/CodeBoard"),
        [
          "--open",
          copy,
          "--board",
          board,
          "--theme",
          theme,
          `--${light}`,
          "--parity",
          cards.join(","),
          "--snapshot",
          dest,
        ],
        { stdio: ["ignore", "ignore", "inherit"], timeout: 300_000 },
      );
    }
}
fs.rmSync(copy, { recursive: true, force: true });

// ---------- crops and numbers ----------
const read = (f) => (fs.existsSync(f) ? PNG.sync.read(fs.readFileSync(f)) : null);
function crop(png, x, y, w, h) {
  const o = new PNG({ width: w, height: h });
  for (let j = 0; j < h; j++)
    for (let i = 0; i < w; i++) {
      const sx = x + i,
        sy = y + j,
        d = (j * w + i) * 4;
      if (sx < 0 || sy < 0 || sx >= png.width || sy >= png.height) {
        o.data[d + 3] = 0;
        continue;
      }
      const s = (sy * png.width + sx) * 4;
      o.data[d] = png.data[s];
      o.data[d + 1] = png.data[s + 1];
      o.data[d + 2] = png.data[s + 2];
      o.data[d + 3] = png.data[s + 3];
    }
  return o;
}
/** The numbers for a pair over a band of rows: mean colour distance (0–255, per channel), share of pixels off by more than 24 */
function measure(a, b, y0, y1) {
  const w = Math.min(a.width, b.width);
  let sum = 0,
    off = 0,
    n = 0;
  for (let y = y0; y < Math.min(y1, a.height, b.height); y++)
    for (let x = 0; x < w; x++) {
      const i = (y * a.width + x) * 4,
        j = (y * b.width + x) * 4;
      const d =
        (Math.abs(a.data[i] - b.data[j]) +
          Math.abs(a.data[i + 1] - b.data[j + 1]) +
          Math.abs(a.data[i + 2] - b.data[j + 2])) /
        3;
      sum += d;
      if (d > 24) off++;
      n++;
    }
  return n ? { mean: +(sum / n).toFixed(2), off: +((off / n) * 100).toFixed(2) } : { mean: 0, off: 0 };
}
/** A heat map: where the two differ, the brighter the more */
function heat(a, b) {
  const w = Math.min(a.width, b.width),
    h = Math.min(a.height, b.height),
    o = new PNG({ width: w, height: h });
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = (y * a.width + x) * 4,
        j = (y * b.width + x) * 4,
        k = (y * w + x) * 4;
      const d = Math.min(
        255,
        (Math.abs(a.data[i] - b.data[j]) +
          Math.abs(a.data[i + 1] - b.data[j + 1]) +
          Math.abs(a.data[i + 2] - b.data[j + 2])) *
          1.5,
      );
      o.data[k] = 255;
      o.data[k + 1] = 255 - d;
      o.data[k + 2] = 255 - d;
      o.data[k + 3] = 255;
    }
  return o;
}
const esc = (s) => s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]);

const report = {};
for (const theme of themes)
  for (const light of ["light", "dark"]) {
    const name = `${theme}-${light}`;
    const webDir = path.join(out, `web-${name}`),
      appDir = path.join(out, `app-${name}`);
    const rows = [];
    report[name] = {};
    for (const id of cards)
      for (const state of ["show", "sel"]) {
        const wbox = JSON.parse(fs.readFileSync(path.join(webDir, `${id}.json`), "utf8"));
        const abox = fs.existsSync(path.join(appDir, `${id}.json`))
          ? JSON.parse(fs.readFileSync(path.join(appDir, `${id}.json`), "utf8"))
          : null;
        const web = read(path.join(webDir, `${id}-${state}.png`));
        const whole = abox && read(path.join(appDir, `${id}-${state}.png`));
        const W = Math.round((Math.max(wbox.w, abox?.w ?? 0) + 2 * PAD) * SCALE),
          H = Math.round((Math.max(wbox.h, abox?.h ?? 0) + 2 * PAD) * SCALE);
        const a = web && crop(web, 0, 0, W, H);
        const b = whole && crop(whole, Math.round((abox.x - PAD) * SCALE), Math.round((abox.y - PAD) * SCALE), W, H);
        const cell = `${name}-${id}-${state}`;
        let m = null;
        if (a && b) {
          fs.writeFileSync(path.join(out, `${cell}-web.png`), PNG.sync.write(a));
          fs.writeFileSync(path.join(out, `${cell}-app.png`), PNG.sync.write(b));
          fs.writeFileSync(path.join(out, `${cell}-diff.png`), PNG.sync.write(heat(a, b)));
          const headEnd = (PAD + HEAD) * SCALE;
          m = {
            all: measure(a, b, 0, H),
            head: measure(a, b, PAD * SCALE, headEnd),
            body: measure(a, b, headEnd, H),
            dh: +(abox.h - wbox.h).toFixed(1),
            dw: +(abox.w - wbox.w).toFixed(1),
          };
        }
        report[name][`${id}/${state}`] = m ?? "missing";
        rows.push({ id, state, cell, m, W, H, has: !!(a && b) });
      }
    const html = [
      `<!doctype html><meta charset="utf-8"><title>parity ${name}</title><style>body{margin:16px;font:13px -apple-system,sans-serif;background:#888;color:#111}h2{font-size:14px;margin:18px 0 4px}.row{display:flex;gap:12px;align-items:flex-start;margin-bottom:10px}.row img{display:block;max-width:560px}.n{background:#fff;padding:6px 8px;border-radius:6px;min-width:180px;font:12px ui-monospace,monospace}.miss{width:200px;height:60px;background:#fcc}</style>`,
    ];
    for (const r of rows) {
      html.push(`<h2>${esc(r.id)} — ${r.state} — ${name}</h2><div class="row">`);
      if (r.has) {
        html.push(
          `<img src="${r.cell}-web.png" width="${r.W / 2}"><img src="${r.cell}-app.png" width="${r.W / 2}"><img src="${r.cell}-diff.png" width="${r.W / 2}">`,
        );
        html.push(
          `<div class="n">all: mean ${r.m.all.mean} off ${r.m.all.off}%<br>head: mean ${r.m.head.mean} off ${r.m.head.off}%<br>body: mean ${r.m.body.mean} off ${r.m.body.off}%<br>size: Δw ${r.m.dw} Δh ${r.m.dh}</div>`,
        );
      } else html.push(`<div class="miss">missing</div>`);
      html.push("</div>");
    }
    fs.writeFileSync(path.join(out, `${name}.html`), html.join("\n"));
  }
fs.writeFileSync(path.join(out, "parity.json"), JSON.stringify(report, null, 2));
for (const [name, cells] of Object.entries(report)) {
  const ms = Object.values(cells).filter((m) => typeof m === "object");
  const mean = ms.length ? (ms.reduce((s, m) => s + m.all.mean, 0) / ms.length).toFixed(2) : "-";
  const off = ms.length ? (ms.reduce((s, m) => s + m.all.off, 0) / ms.length).toFixed(1) : "-";
  console.log(
    `${name}: mean ${mean}, off ${off}% over ${ms.length} pictures (${Object.values(cells).length - ms.length} missing) → ${path.join(out, `${name}.html`)}`,
  );
}
