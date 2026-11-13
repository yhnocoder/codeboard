// The Markdown look comparison: each Markdown file drawn by the Note page (the web editor, headless Chromium) and by the
// native renderer (swift run MarkdownLook), side by side with their difference, per theme and appearance. Output in
// apps/macos/.build-look/markdown/<look>[-dark]/<name>.png (web | native | difference). Build the page first
// (npm run build -w @yhnocoder/markdown && node apps/macos/web/build.mjs), then:
//   node apps/macos/tools/markdown/look.mjs [files.md…]   (default: tools/markdown/look/*.md)
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import sharp from "sharp";
import { launch } from "../../../../tools/test/chromium.mjs";

const here = import.meta.dirname;
const mac = path.resolve(here, "../..");
const out = path.join(mac, ".build-look/markdown");
const WIDTH = 332; // a 360 px Note's body (its padding 14 px a side)
const SCALE = 2;
const files = process.argv.slice(2).length
  ? process.argv.slice(2)
  : fs.readdirSync(path.join(here, "look")).filter((f) => f.endsWith(".md")).map((f) => path.join(here, "look", f));
const looks = ["warm-ink", "ink-wash"].flatMap((look) => [false, true].map((dark) => ({ look, dark })));

execFileSync("swift", ["build", "-c", "release", "--product", "MarkdownLook"], { cwd: mac, stdio: "inherit" });
const bin = path.join(mac, ".build/release/MarkdownLook");

const browser = await launch();
for (const { look, dark } of looks) {
  const dir = path.join(out, `${look}${dark ? "-dark" : ""}`);
  fs.mkdirSync(path.join(dir, "web"), { recursive: true });
  // native
  execFileSync(bin, [path.join(dir, "native"), String(WIDTH), look, dark ? "1" : "0", String(SCALE), ...files], {
    stdio: "inherit",
  });
  // web: one page per file, the Note's content only (its paper is the canvas's)
  for (const f of files) {
    const name = path.basename(f, ".md");
    const page = await browser.newPage({ viewport: { width: 800, height: 2000 }, deviceScaleFactor: SCALE });
    await page.goto(pathToFileURL(path.join(mac, "web/dist/page.html")).href);
    await page.waitForFunction(() => window.note);
    const text = fs.readFileSync(f, "utf8");
    // the page serves addresses under images/ from this folder (Markdown.setAssetBase("images", …))
    const images = pathToFileURL(path.join(path.dirname(f), "images")).href;
    await page.evaluate(
      ([text, look, dark, images]) =>
        window.note.mount([
          { id: "n", note: { text, layout: null, style: { note: {} }, width: 360, height: null, look, dark, refs: [] }, images },
        ]),
      [text, look, dark, images],
    );
    await page.evaluate(() => window.note.show("n", 1));
    const el = await page.$(".md-pm");
    const bg = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--surface"));
    await page.evaluate((bg) => {
      document.body.style.background = bg;
    }, bg);
    await el.screenshot({ path: path.join(dir, "web", `${name}.png`) });
    await page.close();
    await sheet(path.join(dir, "web", `${name}.png`), path.join(dir, "native", `${name}.png`), path.join(dir, `${name}.png`));
  }
}
await browser.close();
console.log(`wrote ${out}`);

/** web | native | difference, top aligned */
async function sheet(webPng, nativePng, to) {
  const [a, b] = await Promise.all([webPng, nativePng].map((p) => sharp(p).ensureAlpha().raw().toBuffer({ resolveWithObject: true })));
  const w = Math.max(a.info.width, b.info.width);
  const h = Math.max(a.info.height, b.info.height);
  const pad = (img) =>
    sharp(img.data, { raw: img.info })
      .extend({ right: w - img.info.width, bottom: h - img.info.height, background: { r: 255, g: 0, b: 255, alpha: 1 } })
      .raw()
      .toBuffer();
  const [pa, pb] = await Promise.all([pad(a), pad(b)]);
  const diff = Buffer.alloc(w * h * 4);
  for (let i = 0; i < w * h * 4; i += 4) {
    const d = Math.abs(pa[i] - pb[i]) + Math.abs(pa[i + 1] - pb[i + 1]) + Math.abs(pa[i + 2] - pb[i + 2]);
    const v = Math.min(255, d);
    diff[i] = 255;
    diff[i + 1] = 255 - v;
    diff[i + 2] = 255 - v;
    diff[i + 3] = 255;
  }
  const gap = 16;
  await sharp({ create: { width: w * 3 + gap * 2, height: h, channels: 4, background: { r: 128, g: 128, b: 128, alpha: 1 } } })
    .composite([
      { input: pa, raw: { width: w, height: h, channels: 4 }, left: 0, top: 0 },
      { input: pb, raw: { width: w, height: h, channels: 4 }, left: w + gap, top: 0 },
      { input: diff, raw: { width: w, height: h, channels: 4 }, left: 2 * (w + gap), top: 0 },
    ])
    .png()
    .toFile(to);
}
