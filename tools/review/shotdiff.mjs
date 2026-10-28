// Screenshot diff: compare each screenshot of this run with the baseline; write "before | after | diff" triptychs and a summary.
// Usage: node tools/review/shotdiff.mjs <baseline dir> <this run dir> <out dir> [image URL prefix] [image URL suffix]
// Output: <out>/<name>.png (triptychs, only for changed or new steps), summary.json, summary.md (for the PR description / task report)
import * as fs from "node:fs";
import * as path from "node:path";
import { launch } from "../test/chromium.mjs";

const [base, head, out, urlPrefix = "", urlSuffix = ""] = process.argv.slice(2);
if (!base || !head || !out) { console.error("usage: shotdiff.mjs <baseline> <head> <out> [URL prefix]"); process.exit(2); }
const THRESH = 32;        // a pixel counts as changed when any channel differs by more than this (filters antialiasing)
const CHANGED = 0.005;    // a step counts as changed when more than 0.5% of pixels changed (filters caret blink, late semantic highlighting, etc.)
fs.mkdirSync(out, { recursive: true });
const pngs = (d) => (fs.existsSync(d) ? fs.readdirSync(d).filter((n) => n.endsWith(".png")).sort() : []);
const browser = await launch();
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
    // triptych: before | after | diff, each scaled to half width
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
const label = { new: "new", removed: "removed", changed: "changed" };
const md = [
  `**Screenshot diff**: ${results.length} steps, ${changed.length} changed${changed.length ? "" : ", identical to baseline"}.`,
  "",
  ...changed.flatMap((x) => [`**${x.name.replace(/\.png$/, "")}** · ${label[x.status]}${x.status === "changed" ? ` · ${(x.ratio * 100).toFixed(1)}% of pixels` : ""}`, "", `![${x.name}](${urlPrefix}${x.name}${urlSuffix})`, ""]),
].join("\n");
fs.writeFileSync(path.join(out, "summary.md"), md);
console.log(md.split("\n")[0]);
for (const x of changed) console.log(`  ${label[x.status]} ${x.name} ${x.ratio}`);
