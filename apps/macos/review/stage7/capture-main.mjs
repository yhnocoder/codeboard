// main's side of the stage 7 sheets: the Storybook stories (built with `npm run storybook:check` or `npx storybook build`
// into test-out/storybook, served at 127.0.0.1:8765) at 2x in each theme, and the stories' fake page pictures as PNGs
// for the native side. node apps/macos/review/stage7/capture-main.mjs <out> <story id>…
import { launch } from "../../../../tools/test/chromium.mjs";
const b = await launch();
const out = process.argv[2];
const stories = process.argv.slice(3);
const looks = [["warm-ink", "light", "warm-ink"], ["warm-ink", "dark", "warm-ink-dark"], ["ink-wash", "light", "ink-wash"], ["ink-wash", "dark", "ink-wash-dark"]];
for (const id of stories) for (const [look, scheme, suffix] of looks) {
  const p = await b.newPage({ deviceScaleFactor: 2, viewport: { width: 1500, height: 900 } });
  await p.goto(`http://127.0.0.1:8765/iframe.html?id=${id}&viewMode=story&globals=theme:${look};scheme:${scheme}`);
  await p.waitForTimeout(3000);
  await p.screenshot({ path: `${out}/${id}-${suffix}.png` });
  await p.close();
}
// the fake pages' pictures as PNGs, for the native side
const og = (a, c, t, w = 600, h = 315) => `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${a}"/><stop offset="1" stop-color="${c}"/></linearGradient></defs><rect width="${w}" height="${h}" fill="url(#g)"/><text x="30" y="${h * 0.58}" font-family="Georgia" font-size="${Math.round(h * 0.13)}" fill="#fff">${t}</text></svg>`;
const fav = (c, t) => `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><rect width="32" height="32" rx="7" fill="${c}"/><text x="16" y="22" font-family="Arial" font-weight="700" font-size="17" fill="#fff" text-anchor="middle">${t}</text></svg>`;
const svgs = { "og-full": [og("#3b2a6b", "#7a5bd1", "PagedAttention"), 600, 315], "og-square": [og("#e4572e", "#f2a541", "FI", 300, 300), 300, 300],
  "fav-a": [fav("#b31b1b", "a"), 32, 32], "fav-F": [fav("#e4572e", "F"), 32, 32], "fav-gh": [fav("#24292f", ""), 32, 32], "fav-T": [fav("#5b7bd5", "T"), 32, 32] };
for (const [name, [svg, w, h]] of Object.entries(svgs)) {
  const p = await b.newPage({ deviceScaleFactor: 2, viewport: { width: w, height: h } });
  await p.setContent(`<html><body style="margin:0;background:transparent">${svg}</body></html>`);
  await p.screenshot({ path: `${out}/${name}.png`, omitBackground: true, clip: { x: 0, y: 0, width: w, height: h } });
  await p.close();
}
await b.close();
