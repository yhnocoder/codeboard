// 截图比对：把这次的截图和基线逐张比，生成"前 | 后 | 差异"三联图和汇总。
// 用法：node tools/review/shotdiff.mjs <基线目录> <这次目录> <输出目录> [图片 URL 前缀] [图片 URL 后缀]
// 输出：<输出>/<名>.png（三联图，只有变化或新增的步骤）、summary.json、summary.md（给 PR 描述 / 任务报告用）
import * as fs from "node:fs";
import * as path from "node:path";
import { chromium } from "playwright-core";

const [base, head, out, urlPrefix = "", urlSuffix = ""] = process.argv.slice(2);
if (!base || !head || !out) { console.error("用法：shotdiff.mjs <基线> <这次> <输出> [URL 前缀]"); process.exit(2); }
const THRESH = 32;        // 单个像素任一通道差超过这个值才算变了（滤掉抗锯齿）
const CHANGED = 0.002;    // 变化像素超过 0.2% 才算这一步变了（滤掉光标闪烁等）
fs.mkdirSync(out, { recursive: true });
const pngs = (d) => (fs.existsSync(d) ? fs.readdirSync(d).filter((n) => n.endsWith(".png")).sort() : []);
const exe = process.env.CHROMIUM ?? (fs.existsSync("/opt/pw-browsers/chromium-1194/chrome-linux/chrome") ? "/opt/pw-browsers/chromium-1194/chrome-linux/chrome" : undefined);
const browser = await chromium.launch({ executablePath: exe });
const page = await browser.newPage();
const b64 = (p) => (p && fs.existsSync(p) ? "data:image/png;base64," + fs.readFileSync(p).toString("base64") : null);

const results = [];
const names = [...new Set([...pngs(head), ...pngs(base)])];
for (const name of names) {
  const a = b64(path.join(base, name)), b = b64(path.join(head, name));
  const r = await page.evaluate(async ({ a, b, THRESH }) => {
    const load = (src) => src && new Promise((ok, no) => { const i = new Image(); i.onload = () => ok(i); i.onerror = no; i.src = src; });
    const [ia, ib] = await Promise.all([load(a), load(b)]);
    const w = Math.max(ia?.width ?? 0, ib?.width ?? 0), h = Math.max(ia?.height ?? 0, ib?.height ?? 0);
    const grab = (img) => { const c = new OffscreenCanvas(w, h); const x = c.getContext("2d"); x.fillStyle = "#808080"; x.fillRect(0, 0, w, h); if (img) x.drawImage(img, 0, 0); return x.getImageData(0, 0, w, h); };
    const da = grab(ia), db = grab(ib);
    const diff = new ImageData(w, h);
    let n = 0;
    for (let i = 0; i < da.data.length; i += 4) {
      const d = Math.max(Math.abs(da.data[i] - db.data[i]), Math.abs(da.data[i + 1] - db.data[i + 1]), Math.abs(da.data[i + 2] - db.data[i + 2]));
      if (d > THRESH) { n++; diff.data.set([255, 40, 60, 255], i); }
      else { const g = (db.data[i] + db.data[i + 1] + db.data[i + 2]) / 3 * 0.35; diff.data.set([g, g, g, 255], i); }
    }
    const ratio = n / (w * h);
    // 三联图：前 | 后 | 差异，各缩到一半宽
    const s = 0.5, gap = 12, W = Math.round(w * s), H = Math.round(h * s);
    const c = new OffscreenCanvas(W * 3 + gap * 2, H + 28); const x = c.getContext("2d");
    x.fillStyle = "#1b1b1b"; x.fillRect(0, 0, c.width, c.height);
    x.fillStyle = "#ddd"; x.font = "16px sans-serif";
    ["Before", "After", "Diff"].forEach((t, k) => x.fillText(t, k * (W + gap) + 4, 19));
    const dc = new OffscreenCanvas(w, h); dc.getContext("2d").putImageData(diff, 0, 0);
    [ia, ib, dc].forEach((img, k) => { if (img) x.drawImage(img, k * (W + gap), 28, W, H); });
    const blob = await c.convertToBlob({ type: "image/png" });
    const buf = new Uint8Array(await blob.arrayBuffer());
    let bin = ""; for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
    return { ratio, png: btoa(bin) };
  }, { a, b, THRESH });
  const status = !a ? "new" : !b ? "removed" : r.ratio > CHANGED ? "changed" : "same";
  if (status !== "same") fs.writeFileSync(path.join(out, name), Buffer.from(r.png, "base64"));
  results.push({ name, status, ratio: +r.ratio.toFixed(4) });
}
await browser.close();

fs.writeFileSync(path.join(out, "summary.json"), JSON.stringify(results, null, 1));
const changed = results.filter((x) => x.status !== "same");
const label = { new: "新增", removed: "删除", changed: "变化" };
const md = [
  `**截图比对**：${results.length} 步，${changed.length} 步有变化${changed.length ? "" : "，和基线一致"}。`,
  "",
  ...changed.flatMap((x) => [`**${x.name.replace(/\.png$/, "")}** · ${label[x.status]}${x.status === "changed" ? ` · ${(x.ratio * 100).toFixed(1)}% 像素` : ""}`, "", `![${x.name}](${urlPrefix}${x.name}${urlSuffix})`, ""]),
].join("\n");
fs.writeFileSync(path.join(out, "summary.md"), md);
console.log(md.split("\n")[0]);
for (const x of changed) console.log(`  ${label[x.status]} ${x.name} ${x.ratio}`);
