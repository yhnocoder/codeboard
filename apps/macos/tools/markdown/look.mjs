// The Note look comparison: each card drawn by the web board (the reference page, page/: the web editor in headless
// Chromium) and by the app's own Note path (swift run MarkdownLook: CodeBoardNotes over CodeBoardMarkdownUI), side by
// side with their difference, per theme and appearance. The cards: every look/*.md as a Note 360 wide, and the styled
// cards of look/cards.json (Text, Box, Mark, Free Text); [[refs]] resolve as look/refs.json says; code is coloured by
// the app's highlighter on both sides. Output in apps/macos/.build-look/markdown/<look>[-dark]/<name>.png (web | native
// | difference). Build the Markdown package first (npm run build -w @yhnocoder/markdown; the reference page is built
// here), then:
//   node apps/macos/tools/markdown/look.mjs [names…]   (default: all)
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import sharp from "sharp";
import { launch } from "../../../../tools/test/chromium.mjs";
import { buildPage } from "./page/build.mjs";

const here = import.meta.dirname;
const mac = path.resolve(here, "../..");
const samples = path.join(here, "look");
const out = path.join(mac, ".build-look/markdown");
const SCALE = 2;
const only = new Set(process.argv.slice(2));
const refs = JSON.parse(fs.readFileSync(path.join(samples, "refs.json"), "utf8"));
const jobs = [
  ...fs
    .readdirSync(samples)
    .filter((f) => f.endsWith(".md"))
    .map((f) => ({
      name: path.basename(f, ".md"),
      text: fs.readFileSync(path.join(samples, f), "utf8"),
      style: { note: {} },
      width: 360,
    })),
  ...JSON.parse(fs.readFileSync(path.join(samples, "cards.json"), "utf8")),
]
  .filter((j) => !only.size || only.has(j.name))
  .map((j) => ({ height: null, ...j, folder: samples, refs }));
const looks = ["warm-ink", "ink-wash"].flatMap((look) => [false, true].map((dark) => ({ look, dark })));

execFileSync("swift", ["build", "-c", "release", "--product", "MarkdownLook"], { cwd: mac, stdio: "inherit" });
const bin = path.join(mac, ".build/release/MarkdownLook");
const pageHtml = await buildPage();
const browser = await launch();
fs.mkdirSync(out, { recursive: true });
fs.writeFileSync(path.join(out, "jobs.json"), JSON.stringify(jobs));
/** the web board's ref hits: a found one's seal colour is the board's variable */
const webRefs = refs.map((r) => ({
  ...r,
  hit: r.hit.broken
    ? r.hit
    : { id: "", title: r.hit.title, ...(r.hit.seal && { seal: { ...r.hit.seal, color: `var(--seal-${r.hit.seal.color})` } }) },
}));
for (const { look, dark } of looks) {
  const dir = path.join(out, `${look}${dark ? "-dark" : ""}`);
  fs.mkdirSync(path.join(dir, "web"), { recursive: true });
  execFileSync(bin, [path.join(out, "jobs.json"), path.join(dir, "native"), look, dark ? "1" : "0", String(SCALE)], {
    stdio: "inherit",
  });
  const tokens = JSON.parse(fs.readFileSync(path.join(dir, "native", "tokens.json"), "utf8"));
  for (const job of jobs) {
    const page = await browser.newPage({ viewport: { width: 1200, height: 3000 }, deviceScaleFactor: SCALE });
    await page.goto(pathToFileURL(pageHtml).href);
    await page.waitForFunction(() => window.note);
    await page.evaluate((t) => {
      window.noteTokens = t;
    }, tokens);
    const images = pathToFileURL(path.join(samples, "images")).href;
    // a diagram through the static render: the editor shows Mermaid as source
    const note = {
      text: job.text,
      layout: null,
      style: job.style,
      width: job.width,
      height: job.height,
      look,
      dark,
      refs: webRefs,
      static: job.text.includes("```mermaid"),
    };
    await page.evaluate(([note, images]) => window.note.mount([{ id: "n", note, images }]), [note, images]);
    if (note.static) await page.waitForFunction(() => !document.querySelector(".mmd") || document.querySelector(".mmd svg"));
    // an animated image stands still on the frame {frame=N} names, as the board makes it (the package leaves that to
    // the page): the frame decoded from the file and shown in its place
    for (const { src, frame } of await page.$$eval("img[data-frame]", (els) =>
      els.map((e) => ({ src: e.currentSrc || e.src, frame: Number(e.dataset.frame) })),
    )) {
      if (!src.startsWith("file:") || !(frame > 1)) continue;
      const bytes = fs.readFileSync(fileURLToPath(src)).toString("base64");
      const type = `image/${path.extname(fileURLToPath(src)).slice(1).replace("jpg", "jpeg")}`;
      await page.evaluate(
        async ([src, bytes, type, frame]) => {
          const data = Uint8Array.from(atob(bytes), (c) => c.charCodeAt(0));
          const { image } = await new ImageDecoder({ data, type }).decode({ frameIndex: frame - 1 });
          const c = document.createElement("canvas");
          c.width = image.displayWidth;
          c.height = image.displayHeight;
          c.getContext("2d").drawImage(image, 0, 0);
          const url = c.toDataURL();
          for (const img of document.querySelectorAll("img[data-frame]"))
            if ((img.currentSrc || img.src) === src) {
              img.src = url;
              await img.decode();
            }
        },
        [src, bytes, type, frame],
      );
    }
    await page.evaluate(() => window.note.show("n", 1));
    // code colours come in after the first paint
    await page.waitForTimeout(300);
    const bg = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--surface"));
    await page.evaluate((bg) => {
      document.body.style.background = bg;
    }, bg);
    const card = await page.$("#root > .slot.shown .card");
    await card.screenshot({ path: path.join(dir, "web", `${job.name}.png`) });
    await page.close();
    await sheet(path.join(dir, "web", `${job.name}.png`), path.join(dir, "native", `${job.name}.png`), path.join(dir, `${job.name}.png`));
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
