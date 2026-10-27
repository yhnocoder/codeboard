// Stack the per-theme card shots into one picture: the first theme in full, every other theme as a narrow slice behind it, like a fanned deck.
// Usage: node tools/release/compose-themes.mjs <dir with <theme>.png> <out.png> <light|dark>
// Each shot is one card on the board's background; each slice is zoomed in on the card's left edge (heading, line numbers, start of the code),
// taken from <theme>.json written next to the shot (the card's box in CSS px); without it the slice shows a fixed strip of the shot.
// Theme order and labels follow THEMES below (the order of the board's Settings page); missing shots are skipped.
import * as fs from "node:fs";
import * as path from "node:path";
import { chromium } from "playwright-core";
import { CHROMIUM } from "../test/chromium.mjs";

const THEMES = [["warm-ink", "Warm Ink"], ["graphite", "Graphite"], ["soft-light", "Soft Light"], ["drafting", "Drafting"], ["colorful", "Colorful"], ["newspaper", "Newspaper"], ["poster", "Poster"], ["classic", "Classic"], ["ink-wash", "Ink Wash"]];
const [dir, out, mode = "light"] = process.argv.slice(2);
if (!dir || !out) { console.error("usage: compose-themes.mjs <dir> <out.png> [light|dark]"); process.exit(2); }
const shots = THEMES.filter(([f]) => fs.existsSync(path.join(dir, `${f}.png`)));
if (!shots.length) { console.error(`no theme shots in ${dir}`); process.exit(1); }
const b64 = (f) => "data:image/png;base64," + fs.readFileSync(path.join(dir, `${f}.png`)).toString("base64");
const meta = (f) => { try { return JSON.parse(fs.readFileSync(path.join(dir, `${f}.json`), "utf8")); } catch { return null; } };

// Layout in CSS px (rendered at 2x). Every shot is drawn at its own size (2 device px per CSS px, as taken), never scaled, so code is
// the same size in every panel: the front shot in full, then one SLICE-wide strip per other theme with its card's top edge at the
// same height as the front card's
const SLICE = 120, PAD = 40, R = 14;
const front = meta(shots[0][0]);
const [w0, h0] = (() => { const b = fs.readFileSync(path.join(dir, `${shots[0][0]}.png`)); return [b.readUInt32BE(16) / 2, b.readUInt32BE(20) / 2]; })();
const W = Math.round(w0), H = Math.round(h0);
const dark = mode === "dark";
// Theme names sit in one row under the panels: under the front shot, and under the visible part of each slice
const LABEL = 40;
const css = `
  body { margin: 0; background: ${dark ? "#161618" : "#ecebe7"}; font: 600 14px/1 -apple-system, "Segoe UI", Inter, system-ui, sans-serif; }
  .stage { position: relative; width: ${W + SLICE * (shots.length - 1)}px; height: ${H + LABEL}px; padding: ${PAD}px; }
  .shot { position: absolute; top: ${PAD}px; height: ${H}px; border-radius: ${R}px; overflow: hidden; background-repeat: no-repeat; background-size: ${W}px ${H}px; background-color: ${dark ? "#1e1e1e" : "#f3f2ee"};
          box-shadow: 0 0 0 1px ${dark ? "rgba(255,255,255,.07)" : "rgba(0,0,0,.06)"}, ${dark ? "-10px 6px 22px rgba(0,0,0,.55)" : "-8px 6px 20px rgba(0,0,0,.13)"}; }
  .label { position: absolute; top: ${PAD + H + 18}px; text-align: center; white-space: nowrap; color: ${dark ? "#c9c8c4" : "#4a4844"}; letter-spacing: .01em; }`;
// Slices sit behind the front shot and each other. A slice shows its theme's card from just left of the card's edge
const slice = (f) => {
  const m = meta(f);
  const [w, h] = (() => { const b = fs.readFileSync(path.join(dir, `${f}.png`)); return [b.readUInt32BE(16) / 2, b.readUInt32BE(20) / 2]; })();
  if (!m || !front) return `background-size:${w}px ${h}px;background-position:${-Math.round(w * 0.1)}px 0`;
  return `background-size:${w}px ${h}px;background-position:${R - (m.card.x - 10)}px ${front.card.y - m.card.y}px`;
};
const html = shots.map(([f, name], i) => i === 0
  ? `<div class="shot" style="left:${PAD}px;width:${W}px;z-index:${shots.length};background-image:url(${b64(f)})"></div><div class="label" style="left:${PAD}px;width:${W}px">${name}</div>`
  : `<div class="shot slice" style="left:${PAD + W + SLICE * (i - 1) - R}px;width:${SLICE + R}px;z-index:${shots.length - i};background-image:url(${b64(f)});${slice(f)}"></div><div class="label" style="left:${PAD + W + SLICE * (i - 1)}px;width:${SLICE}px">${name}</div>`).join("");
const browser = await chromium.launch({ executablePath: CHROMIUM });
const page = await browser.newPage({ deviceScaleFactor: 2, viewport: { width: W + SLICE * (shots.length - 1) + PAD * 2, height: H + LABEL + PAD * 2 } });
await page.setContent(`<style>${css}</style><div class="stage">${html}</div>`);
await page.evaluate(() => document.fonts.ready);
fs.mkdirSync(path.dirname(out), { recursive: true });
await page.screenshot({ path: out });
await browser.close();
console.log(`${out}: ${shots.length} themes`);
