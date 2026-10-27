// Icon check: lint the 16 px grid rules, measure softness, draw a contact sheet (old set vs this one).
// Usage: node tools/icons/check.mjs [--old <git ref>] [--sheet <out.png>] [--json]
//   --old    ref to compare with (default: the last commit before the Lucide redraw)
//   --sheet  also write an old/new contact sheet PNG (1x and 2x zoomed, light and dark, 1 px and 2 px strokes)
// Soft-pixel share = pixels with 0 < alpha < 255 / all pixels with alpha > 0, pooled over every UI icon,
// each icon drawn black on transparent at 16 px, at device scale 1 and 2, with the real .ico CSS from styles.css.
import * as fs from "node:fs";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { chromium } from "playwright-core";
import { CHROMIUM } from "../test/chromium.mjs";

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../..");
const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const OLD = arg("--old", "dba8f57");
const SHEET = arg("--sheet");
const ICONS = "packages/board/src/ui/icons.tsx", CSS = "packages/board/src/styles.css";
const git = (f) => execFileSync("git", ["show", `${OLD}:${f}`], { cwd: root, encoding: "utf8" });
const cur = (f) => fs.readFileSync(path.join(root, f), "utf8");

// const P / const F blocks of icons.tsx: `  name: "path data",`
const block = (src, v) => { const m = src.match(new RegExp(`const ${v}[^=]*= \\{([\\s\\S]*?)\\n\\};`)); const o = {}; if (m) for (const x of m[1].matchAll(/^\s+(\w+): "([^"]*)",?(?:\s*\/\/.*)?$/gm)) o[x[1]] = x[2]; return o; };
const icoCss = (src) => src.split("\n").filter((l) => /^\.ico[\s.,:{>]/.test(l)).join("\n");

// sticker built-ins: { name, color, d | fill } rows of BUILTIN in stickers/glyphs.tsx
const GLYPHS = "packages/board/src/stickers/glyphs.tsx";
const stickers = (src) => [...src.matchAll(/\{ name: "([\w-]+)", label: "[^"]*", color: "(#\w+)", (d|fill): "([^"]*)" \}/g)].map(([, name, color, k, d]) => ({ name, color, k, d }));
const stickerSvg = (st, size, isNew) => `<svg viewBox="0 0 24 24" width="${size}" height="${size}" style="display:block"><circle cx="12" cy="12" r="11" fill="${st.color}"/>${st.k === "d"
  ? `<path d="${st.d}" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>`
  : isNew ? `<path d="${st.d}" fill="#fff" stroke="#fff" stroke-width="1" stroke-linejoin="round"/>` : `<path d="${st.d}" fill="#fff"/>`}</svg>`;
const oldStk = stickers(git(GLYPHS)), newStk = stickers(cur(GLYPHS));

const oldSrc = git(ICONS), newSrc = cur(ICONS);
const oldP = block(oldSrc, "P"), newP = block(newSrc, "P"), newF = block(newSrc, "F");
// v0.1.6 drew two icons inline in the code card foot; they are Icon names now
const oldInline = { clock: '<circle cx="8" cy="8" r="5.5"/><path d="M8 5v3l2 1.5"/>', arrowR: '<path d="M3.5 8h9M9 4.5 12.5 8 9 11.5"/>' };
const names = [...new Set([...Object.keys(newP), ...Object.keys(newF)])];
const SETS = {
  old: { css: icoCss(git(CSS)), svg: (n) => `<svg class="ico${n === "more" ? " dots" : ""}" viewBox="0 0 16 16" width="16" height="16">${oldInline[n] ?? `<path d="${oldP[n] ?? ""}"/>`}</svg>`, has: (n) => n in oldP || n in oldInline },
  new: { css: icoCss(cur(CSS)), svg: (n) => `<svg class="ico" viewBox="0 0 16 16" width="16" height="16">${newP[n] ? `<path d="${newP[n]}"/>` : ""}${newF[n] ? `<path class="f" d="${newF[n]}"/>` : ""}</svg>`, has: () => true },
};

// ---- lint: in the 2 px geometry every horizontal / vertical stroke sits on whole pixels, fills on whole pixels ----
function segs(d) {
  const t = d.match(/[a-zA-Z]|-?(?:\d+\.?\d*|\.\d+)(?:e-?\d+)?/g) ?? []; let i = 0, cmd = "", x = 0, y = 0, sx = 0, sy = 0; const out = [];
  const num = () => +t[i++];
  while (i < t.length) {
    if (/[a-zA-Z]/.test(t[i])) cmd = t[i++];
    const rel = cmd === cmd.toLowerCase(), C = cmd.toUpperCase();
    const p = (ax, ay) => (rel ? [x + ax, y + ay] : [ax, ay]);
    if (C === "M") { [x, y] = p(num(), num()); sx = x; sy = y; out.push({ k: "M", x, y }); cmd = rel ? "l" : "L"; }
    else if (C === "L") { const [nx, ny] = p(num(), num()); out.push({ k: "L", x0: x, y0: y, x: nx, y: ny }); [x, y] = [nx, ny]; }
    else if (C === "H") { const nx = rel ? x + num() : num(); out.push({ k: "L", x0: x, y0: y, x: nx, y }); x = nx; }
    else if (C === "V") { const ny = rel ? y + num() : num(); out.push({ k: "L", x0: x, y0: y, x, y: ny }); y = ny; }
    else if (C === "A") { const rx = num(), ry = num(); num(); const la = num(), sw = num(); const [nx, ny] = p(num(), num()); out.push({ k: "A", x0: x, y0: y, rx, ry, la, sw, x: nx, y: ny }); [x, y] = [nx, ny]; }
    else if (C === "C") { const a = p(num(), num()), b = p(num(), num()), [nx, ny] = p(num(), num()); out.push({ k: "C", x0: x, y0: y, x: nx, y: ny, a, b }); [x, y] = [nx, ny]; }
    else if (C === "S") { const b = p(num(), num()), [nx, ny] = p(num(), num()); out.push({ k: "C", x0: x, y0: y, x: nx, y: ny, b }); [x, y] = [nx, ny]; }
    else if (C === "T") { const [nx, ny] = p(num(), num()); out.push({ k: "Q", x0: x, y0: y, x: nx, y: ny }); [x, y] = [nx, ny]; }
    else if (C === "Q") { const a = p(num(), num()), [nx, ny] = p(num(), num()); out.push({ k: "Q", x0: x, y0: y, x: nx, y: ny, a }); [x, y] = [nx, ny]; }
    else if (C === "Z") { out.push({ k: "L", x0: x, y0: y, x: sx, y: sy }); x = sx; y = sy; }
    else throw new Error(`path command ${cmd} not handled: ${d}`);
  }
  return out;
}
const whole = (v) => Math.abs(v - Math.round(v)) < 1e-6;
const problems = [];
for (const n of names) {
  for (const s of segs(newP[n] ?? "")) {
    if (s.k === "L" && s.x0 === s.x && s.y0 !== s.y && !whole(s.x)) problems.push(`${n}: vertical stroke at x=${s.x}`);
    if (s.k === "L" && s.y0 === s.y && s.x0 !== s.x && !whole(s.y)) problems.push(`${n}: horizontal stroke at y=${s.y}`);
  }
  for (const s of segs(newF[n] ?? "")) if (s.k !== "M" && (!whole(s.x) || !whole(s.y))) problems.push(`${n}: fill vertex off grid (${s.x},${s.y})`);
}
// the Markdown editor's toolbar icons (packages/markdown/src/editor/icons.tsx) keep the same rule
for (const [n, d] of Object.entries(block(cur("packages/markdown/src/editor/icons.tsx"), "P"))) for (const s of segs(d)) {
  if (s.k === "L" && s.x0 === s.x && s.y0 !== s.y && !whole(s.x)) problems.push(`markdown ${n}: vertical stroke at x=${s.x}`);
  if (s.k === "L" && s.y0 === s.y && s.x0 !== s.x && !whole(s.y)) problems.push(`markdown ${n}: horizontal stroke at y=${s.y}`);
}

// ---- render ----
const browser = await chromium.launch({ executablePath: CHROMIUM });
const GAP = 8, CELL = 16 + GAP;
const LOOK = { light: { bg: "#fbfaf7", ink: "#3a3530" }, dark: { bg: "#2a2725", ink: "#e9e4dc" }, alpha: { bg: "transparent", ink: "#000" } };
async function strip(set, w, dpr, look) {
  const page = await browser.newPage({ deviceScaleFactor: dpr, viewport: { width: names.length * CELL + GAP, height: 40 } });
  const S = SETS[set], L = LOOK[look];
  await page.setContent(`<!doctype html><style>html,body{margin:0;background:${L.bg}}:root{--ico-w:${w}}${S.css}
    #s{position:absolute;left:0;top:0;display:flex;gap:${GAP}px;padding:${GAP / 2}px ${GAP}px;color:${L.ink}}#s>span{width:16px;height:16px;display:block}#s svg{display:block}</style>
    <div id="s">${names.map((n) => `<span>${S.has(n) ? S.svg(n) : ""}</span>`).join("")}</div>`);
  const png = await page.locator("#s").screenshot({ omitBackground: look === "alpha" });
  await page.close();
  return png;
}
const page = await browser.newPage();
async function measure(png, dpr) {
  return page.evaluate(async ({ src, dpr, n, CELL, GAP }) => {
    const img = new Image(); img.src = src; await img.decode();
    const c = new OffscreenCanvas(img.width, img.height), g = c.getContext("2d"); g.drawImage(img, 0, 0);
    const d = g.getImageData(0, 0, img.width, img.height).data, per = [];
    for (let k = 0; k < n; k++) {
      let soft = 0, ink = 0; const x0 = (GAP + k * CELL) * dpr, y0 = (GAP / 2) * dpr;
      for (let y = y0; y < y0 + 16 * dpr; y++) for (let x = x0; x < x0 + 16 * dpr; x++) { const a = d[(y * img.width + x) * 4 + 3]; if (a > 0) { ink++; if (a < 255) soft++; } }
      per.push([soft, ink]);
    }
    return per;
  }, { src: "data:image/png;base64," + png.toString("base64"), dpr, n: names.length, CELL, GAP });
}
// the 26 icons W02 section D measured (its table: v0.1.6 set at 1 px stroke = 60% at 1x, 26% at 2x)
const W02 = ["plus", "minus", "fit", "more", "chev", "close", "play", "search", "note", "code", "image", "web", "section", "link", "text", "undo", "redo", "lock", "pin", "eye", "copy", "trash", "external", "sticker", "check", "alignL"];
const shots = {}, stats = {};
for (const set of ["old", "new"]) for (const w of [1, 2]) for (const dpr of [1, 2]) {
  const per = await measure(await strip(set, w, dpr, "alpha"), dpr);
  const both = per.filter((_, k) => SETS.old.has(names[k]));
  const sum = (a) => a.reduce((s, [x, y]) => [s[0] + x, s[1] + y], [0, 0]);
  const [s, i] = sum(both), [s2, i2] = sum(per.filter((_, k) => W02.includes(names[k])));
  stats[`${set} ${w}px @${dpr}x`] = { share: s / i, w02: s2 / i2, per: Object.fromEntries(names.map((n, k) => [n, per[k][1] ? +(per[k][0] / per[k][1]).toFixed(3) : null])) };
  if (SHEET) for (const look of ["light", "dark"]) shots[`${set}${w}${dpr}${look}`] = (await strip(set, w, dpr, look)).toString("base64");
}

const pct = (v) => `${(v * 100).toFixed(1)}%`;
console.log(`icons: ${names.length} (compared with ${OLD}: ${names.filter((n) => SETS.old.has(n)).length})`);
console.log("soft-pixel share (lower is crisper)   all icons 1x / 2x    W02 subset 1x / 2x");
for (const w of [1, 2]) for (const set of ["old", "new"]) { const a = stats[`${set} ${w}px @1x`], b = stats[`${set} ${w}px @2x`]; console.log(`  ${set} set, ${w}px stroke`.padEnd(38), pct(a.share).padStart(7), pct(b.share).padStart(8), pct(a.w02).padStart(12), pct(b.w02).padStart(8)); }
if (process.argv.includes("--json")) console.log(JSON.stringify(stats, null, 1));
if (problems.length) { console.log(`grid lint: ${problems.length} problem(s)`); for (const p of problems) console.log("  " + p); }
else console.log("grid lint: ok");
let worse = false;
for (const w of [1, 2]) for (const dpr of [1, 2]) if (stats[`new ${w}px @${dpr}x`].share > stats[`old ${w}px @${dpr}x`].share + 1e-9) { worse = true; console.log(`SOFTER than old: ${w}px @${dpr}x`); }

if (SHEET) {
  const sp = await browser.newPage({ deviceScaleFactor: 1, viewport: { width: 1700, height: 1000 } });
  const Z = 4, COLS = 8;                               // 1x drawn 4x, 2x drawn 2x (both 72 px wide with a 1 px margin)
  const im = (key, dpr, k, look) => { const W = (names.length * CELL + GAP) * dpr, s = (Z / dpr) * dpr; const sc = Z / dpr;
    return `<i style="background:url(data:image/png;base64,${shots[key]}) ${-(GAP + k * CELL - 1) * dpr * sc}px ${-(GAP / 2 - 1) * dpr * sc}px/${W * sc}px auto no-repeat ${LOOK[look].bg}"></i>`; };
  const tile = (n, k) => `<div class="t"><b>${n}</b><div class="g">${["light", "dark"].map((look) => [1, 2].map((w) =>
      `<span class="lab">${w}px</span>${["old", "new"].map((set) => [1, 2].map((dpr) => SETS[set].has(n) ? im(`${set}${w}${dpr}${look}`, dpr, k, look) : `<i class="none"></i>`).join("")).join("")}`).join("")).join("")}</div></div>`;
  const row = (look, w) => `<div class="tb ${look}"><span>${look}, ${w}px</span>${["old", "new"].map((set) => `<span class="set">${set}</span><img src="data:image/png;base64,${shots[`${set}${w}1${look}`]}">`).join("")}</div>`;
  const table = [1, 2].map((w) => `<tr><td>${w}px stroke</td>${["old", "new"].map((set) => [1, 2].map((dpr) => `<td>${pct(stats[`${set} ${w}px @${dpr}x`].share)}</td>`).join("")).join("")}</tr>`).join("");
  await sp.setContent(`<!doctype html><style>
    body{margin:0;padding:16px;font:12px system-ui,sans-serif;background:#fff;color:#222;width:max-content}
    h1{font-size:16px;margin:0 0 4px} p{margin:0 0 10px;color:#555}
    table{border-collapse:collapse;margin:0 0 12px} td,th{padding:2px 10px;border-bottom:1px solid #eee;text-align:right} td:first-child,th:first-child{text-align:left}
    .grid{display:grid;grid-template-columns:repeat(${COLS},auto);gap:10px}
    .t{border:1px solid #e3e3df;border-radius:6px;padding:6px} .t b{display:block;margin-bottom:4px;font-size:11px}
    .g{display:grid;grid-template-columns:24px repeat(4,72px);gap:2px;align-items:center}
    .g i{display:block;width:72px;height:72px;image-rendering:pixelated;border-radius:2px} .g i.none{background:repeating-linear-gradient(45deg,#eee 0 4px,#fff 4px 8px)}
    .lab{font-size:10px;color:#888} .hd{font-size:10px;color:#888;text-align:center}
    .tb{display:flex;align-items:center;gap:10px;padding:8px 12px;margin:0 0 6px;border-radius:8px} .tb img{image-rendering:pixelated}
    .tb.light{background:#fbfaf7;color:#3a3530;border:1px solid #ddd} .tb.dark{background:#2a2725;color:#e9e4dc} .tb span{width:70px;font-size:11px} .tb .set{width:auto;opacity:.6}
  </style><h1>UI icons: v0.1.6 set (old) vs Lucide redrawn on the 16 px grid (new)</h1>
  <p>Each tile: columns old 1x, old 2x, new 1x, new 2x (1x zoomed 4x, 2x zoomed 2x, nearest neighbour); rows light 1px, light 2px, dark 1px, dark 2px. Actual size strips below the table.</p>
  <table><tr><th>soft-pixel share</th><th>old 1x</th><th>old 2x</th><th>new 1x</th><th>new 2x</th></tr>${table}</table>
  ${["light", "dark"].map((look) => [1, 2].map((w) => row(look, w)).join("")).join("")}
  <div class="grid">${names.map(tile).join("")}</div>
  <h1 style="margin-top:16px">Sticker built-ins (old row, new row; 14, 22, 32 px and 2x zoom of 32 px)</h1>
  ${[["old", oldStk, false], ["new", newStk, true]].map(([t, list, isNew]) => `<div class="tb light" style="flex-wrap:wrap"><span>${t}</span>${list.map((st) =>
    `<span style="display:flex;gap:6px;align-items:center;width:auto">${[14, 22, 32].map((z) => stickerSvg(st, z, isNew)).join("")}<span style="zoom:2;width:auto">${stickerSvg(st, 32, isNew)}</span></span>`).join("")}</div>`).join("")}`);
  fs.mkdirSync(path.dirname(path.resolve(SHEET)), { recursive: true });
  await sp.screenshot({ path: SHEET, fullPage: true });
  console.log("contact sheet:", SHEET);
}
await browser.close();
process.exit(problems.length || worse ? 1 : 0);
