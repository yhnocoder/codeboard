// Stack the per-theme card shots into one picture: the first theme in full, every other theme as a narrow slice behind it, like a fanned deck.
// Usage: node tools/release/compose-themes.mjs <dir with <theme>.png> <out.png> <light|dark>
// Each shot is one card on the board's background; each slice is zoomed in on the card's left edge (heading, line numbers, start of the code),
// taken from <theme>.json written next to the shot (the card's box in CSS px); without it the slice shows a fixed strip of the shot.
// Theme order and labels follow THEMES below (the order of the board's Settings page); missing shots are skipped.
import * as fs from "node:fs";
import * as path from "node:path";
import { chromium } from "playwright-core";

const THEMES = [["warm-ink", "Warm Ink"], ["graphite", "Graphite"], ["soft-light", "Soft Light"], ["drafting", "Drafting"], ["colorful", "Colorful"], ["newspaper", "Newspaper"], ["poster", "Poster"], ["classic", "Classic"], ["ink-wash", "Ink Wash"]];
const [dir, out, mode = "light"] = process.argv.slice(2);
if (!dir || !out) { console.error("usage: compose-themes.mjs <dir> <out.png> [light|dark]"); process.exit(2); }
const shots = THEMES.filter(([f]) => fs.existsSync(path.join(dir, `${f}.png`)));
if (!shots.length) { console.error(`no theme shots in ${dir}`); process.exit(1); }
const b64 = (f) => "data:image/png;base64," + fs.readFileSync(path.join(dir, `${f}.png`)).toString("base64");
const meta = (f) => { try { return JSON.parse(fs.readFileSync(path.join(dir, `${f}.json`), "utf8")); } catch { return null; } };

// Layout in CSS px (rendered at 2x): the front shot W wide, then one SLICE-wide strip per other theme
const W = 760, SLICE = 120, PAD = 40, R = 14, ZOOM = 1.15;
const [w0, h0] = (() => { const b = fs.readFileSync(path.join(dir, `${shots[0][0]}.png`)); return [b.readUInt32BE(16), b.readUInt32BE(20)]; })();
const H = Math.round((W * h0) / w0);
const dark = mode === "dark";
const css = `
  body { margin: 0; background: ${dark ? "#161618" : "#ecebe7"}; font: 600 15px/1 -apple-system, "Segoe UI", Inter, system-ui, sans-serif; }
  .stage { position: relative; width: ${W + SLICE * (shots.length - 1)}px; height: ${H}px; padding: ${PAD}px; }
  .shot { position: absolute; top: ${PAD}px; height: ${H}px; border-radius: ${R}px; overflow: hidden; background-repeat: no-repeat; background-size: ${W}px ${H}px;
          box-shadow: 0 0 0 1px ${dark ? "rgba(255,255,255,.08)" : "rgba(0,0,0,.08)"}, -14px 0 28px -10px rgba(0,0,0,${dark ? 0.6 : 0.28}); }
  .label { position: absolute; left: 18px; top: 18px; color: #fff; letter-spacing: .02em; }
  .label span { display: inline-block; padding: 7px 12px; border-radius: 999px; background: rgba(20,20,22,.78); box-shadow: 0 0 0 1px rgba(255,255,255,.14); }
  .slice .label { top: auto; bottom: 24px; left: ${R}px; right: 0; display: flex; justify-content: center; }
  .slice .label span { writing-mode: vertical-rl; rotate: 180deg; padding: 12px 7px; white-space: nowrap; }`;
// Slices sit behind the front shot and each other. A slice shows its theme's card from just left of the card's edge, zoomed in,
// with the heading row a little below the top of the strip
const slice = (f, x0) => {
  const m = meta(f);
  if (!m) return `background-size:${W}px ${H}px;background-position:${-Math.round(W * 0.33)}px 0`;
  const k = (W / m.frame.w) * ZOOM, bw = m.frame.w * k, bh = m.frame.h * k;
  const x = R - (m.card.x - 10) * k, y = Math.min(0, Math.max(H - bh, -(m.card.y * k - 12)));
  return `background-size:${bw}px ${bh}px;background-position:${Math.round(x)}px ${Math.round(y)}px`;
};
const html = shots.map(([f, name], i) => i === 0
  ? `<div class="shot" style="left:${PAD}px;width:${W}px;z-index:${shots.length};background-image:url(${b64(f)})"><div class="label"><span>${name}</span></div></div>`
  : `<div class="shot slice" style="left:${PAD + W + SLICE * (i - 1) - R}px;width:${SLICE + R}px;z-index:${shots.length - i};background-image:url(${b64(f)});${slice(f)}"><div class="label"><span>${name}</span></div></div>`).join("");
const exe = process.env.CHROMIUM ?? (fs.existsSync("/opt/pw-browsers/chromium-1194/chrome-linux/chrome") ? "/opt/pw-browsers/chromium-1194/chrome-linux/chrome" : undefined);
const browser = await chromium.launch({ executablePath: exe });
const page = await browser.newPage({ deviceScaleFactor: 2, viewport: { width: W + SLICE * (shots.length - 1) + PAD * 2, height: H + PAD * 2 } });
await page.setContent(`<style>${css}</style><div class="stage">${html}</div>`);
await page.evaluate(() => document.fonts.ready);
fs.mkdirSync(path.dirname(out), { recursive: true });
await page.screenshot({ path: out });
await browser.close();
console.log(`${out}: ${shots.length} themes`);
