// Native against web on the same content and machine: the Markdown component (MarkdownBench) and the Markdown package
// (the look tools' reference page, page/: the web editor with the board's stylesheets, in headless Chromium).
//   node apps/macos/tools/markdown/versus.mjs [--json out.json]
// Needs the Markdown package's build (npm run build -w @yhnocoder/markdown) and the component's assets (assets.mjs).
// Rows, each native | web:
// - first display from a cold process: starting (fonts and engines; the browser and the page), one Note shown, then the
//   forty synthetic Notes (MarkdownBench --write-notes) laid out and drawn
// - memory showing the forty Notes, and with the 1200-paragraph Note open for editing: resident size of the native
//   process, and of every browser process together (browser, renderer, GPU, utility)
// - a key in the 1200-paragraph Note (MarkdownBench --editor's prose row: 500 keys, an Enter every 60, a Backspace every
//   15): native, thread CPU of the edit, the layout and drawing 800 points around the caret at 2x; web, the page's main
//   thread time from the key to the second frame after it (CDP TaskDuration), less that of two frames with no key
import { execFileSync, spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { launch } from "../../../../tools/test/chromium.mjs";
import { buildPage } from "./page/build.mjs";

const here = import.meta.dirname;
const mac = path.join(here, "../..");
const work = fs.mkdtempSync(path.join(os.tmpdir(), "md-versus-"));
const jsonOut = process.argv.includes("--json") ? process.argv[process.argv.indexOf("--json") + 1] : null;

execFileSync("swift", ["build", "-c", "release", "--product", "MarkdownBench"], { cwd: mac, stdio: "inherit" });
const bench = path.join(mac, ".build/release/MarkdownBench");
const run = (...a) => execFileSync(bench, a, { encoding: "utf8", maxBuffer: 64 << 20 });
const notesDir = path.join(work, "notes");
run("--write-notes", notesDir);
const editorNote = path.join(work, "editor.md");
run("--write-editor-note", editorNote);
const manifest = JSON.parse(fs.readFileSync(path.join(notesDir, "notes.json"), "utf8"));
const notes = manifest.map((m) => ({ ...m, text: fs.readFileSync(path.join(notesDir, `${m.name}.md`), "utf8") }));

/** resident size, MB, of these processes and every process under them */
function rss(roots) {
  const rows = execFileSync("ps", ["-A", "-o", "pid=,ppid=,rss="], { encoding: "utf8" })
    .trim()
    .split("\n")
    .map((l) => l.trim().split(/\s+/).map(Number));
  const kids = new Map();
  for (const [pid, ppid] of rows) kids.set(ppid, [...(kids.get(ppid) ?? []), pid]);
  const size = new Map(rows.map(([pid, , kb]) => [pid, kb]));
  let kb = 0;
  const todo = [...roots];
  while (todo.length) {
    const p = todo.pop();
    kb += size.get(p) ?? 0;
    todo.push(...(kids.get(p) ?? []));
  }
  return Math.round(kb / 102.4) / 10;
}

/** the native bench holding something (--hold), its resident size once it says it is ready */
async function nativeHeld(what) {
  const p = spawn(bench, ["--hold", what], { stdio: ["pipe", "pipe", "inherit"] });
  await new Promise((resolve) => p.stdout.on("data", (d) => String(d).includes("ready") && resolve()));
  await new Promise((r) => setTimeout(r, 1000));
  const mb = rss([p.pid]);
  p.stdin.end();
  await new Promise((r) => p.on("exit", r));
  return mb;
}

const median = (v) => [...v].sort((a, b) => a - b)[Math.floor((v.length - 1) / 2)];
const p95 = (v) => [...v].sort((a, b) => a - b)[Math.floor((v.length - 1) * 0.95)];
const round = (x) => Math.round(x * 100) / 100;

// MARK: native
const first = [1, 2, 3].map(() => JSON.parse(run("--first")));
const editor = JSON.parse(run("--editor")).prose;
const native = {
  setup: median(first.map((f) => f.setup_ms)),
  one: median(first.map((f) => f.one_note_ms)),
  forty: median(first.map((f) => f.forty_notes_ms)),
  keyMedian: editor.total_ms.median,
  keyP95: editor.total_ms.p95,
  memNotes: await nativeHeld("notes"),
  memEditor: await nativeHeld("editor"),
};

// MARK: web
const pageHtml = await buildPage();
const images = pathToFileURL(notesDir).href;
const card = (n, text = n.text) => ({
  text,
  layout: null,
  style: n.style,
  width: 360,
  height: null,
  look: "warm-ink",
  dark: false,
  refs: [],
  static: text.includes("```mermaid"),
});

/** a cold browser: started, the page loaded, then `mount` measured */
async function cold(list) {
  const t0 = performance.now();
  const browser = await launch();
  const page = await browser.newPage({ viewport: { width: 1200, height: 900 }, deviceScaleFactor: 2 });
  await page.goto(pathToFileURL(pageHtml).href);
  await page.waitForFunction(() => window.note);
  const t1 = performance.now();
  await page.evaluate(([list, images]) => window.note.mount(list.map((note, i) => ({ id: `n${i}`, note, images }))), [list, images]);
  // shown: each one drawn once, as the board draws every Note in view
  await page.evaluate(async (n) => {
    for (let i = 0; i < n; i++) await window.note.show(`n${i}`, 1);
  }, list.length);
  const t2 = performance.now();
  return { browser, page, setup: t1 - t0, mount: t2 - t1 };
}

const webFirst = [];
for (let i = 0; i < 3; i++) {
  const one = await cold([card(notes[0])]);
  await one.browser.close();
  const all = await cold(notes.map((n) => card(n)));
  webFirst.push({ setup: one.setup, one: one.mount, forty: all.mount, mem: rss([process.pid]) });
  await all.browser.close();
}

// the 1200-paragraph Note open in the editor, 500 keys typed at the same place as the native bench
const ed = await cold([card({ style: { note: {} } }, fs.readFileSync(editorNote, "utf8"))]);
const memEditorWeb = rss([process.pid]);
const page = ed.page;
const at = await page.evaluate(() => {
  const walker = document.createTreeWalker(document.querySelector(".ProseMirror"), NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const i = n.data.indexOf("Paragraph 601 ");
    if (i < 0) continue;
    n.parentElement.scrollIntoView({ block: "center" });
    const r = document.createRange();
    r.setStart(n, i + "Paragraph 601 ".length);
    r.collapse(true);
    const b = r.getBoundingClientRect();
    return { x: b.left + 1, y: b.top + b.height / 2 };
  }
  return null;
});
if (!at) throw new Error("no Paragraph 601 in the web editor");
await page.mouse.click(at.x, at.y);
const cdp = await page.context().newCDPSession(page);
await cdp.send("Performance.enable");
const busy = async () => (await cdp.send("Performance.getMetrics")).metrics.find((m) => m.name === "TaskDuration").value * 1000;
const frames = () => page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
const idle = [];
for (let i = 0; i < 30; i++) {
  const a = await busy();
  await frames();
  idle.push((await busy()) - a);
}
const base = median(idle);
const typed = "the scheduler keeps a batch of requests in flight ";
const keys = [];
for (let k = 0; k < 500; k++) {
  const key = k % 15 === 14 ? "Backspace" : k % 60 === 59 ? "Enter" : typed[k % typed.length] === " " ? "Space" : typed[k % typed.length];
  const a = await busy();
  await page.keyboard.press(key);
  await frames();
  keys.push((await busy()) - a - base);
}
await ed.browser.close();
const web = {
  setup: median(webFirst.map((f) => f.setup)),
  one: median(webFirst.map((f) => f.one)),
  forty: median(webFirst.map((f) => f.forty)),
  keyMedian: median(keys),
  keyP95: p95(keys),
  memNotes: median(webFirst.map((f) => f.mem)),
  memEditor: memEditorWeb,
};

const rows = [
  ["start (fonts, engines | browser, page), ms", "setup"],
  ["one Note shown, ms", "one"],
  ["forty Notes shown, ms", "forty"],
  ["key in a 1200-paragraph Note, median ms", "keyMedian"],
  ["key in a 1200-paragraph Note, p95 ms", "keyP95"],
  ["memory, forty Notes shown, MB", "memNotes"],
  ["memory, 1200-paragraph Note open, MB", "memEditor"],
];
console.log(`\n${"".padEnd(44)}${"native".padStart(10)}${"web".padStart(10)}${"web / native".padStart(14)}`);
for (const [label, k] of rows)
  console.log(
    `${label.padEnd(44)}${String(round(native[k])).padStart(10)}${String(round(web[k])).padStart(10)}${String(round(web[k] / native[k])).padStart(14)}`,
  );
console.log(`(${os.cpus()[0].model}, ${os.cpus().length} cores; native key: thread CPU, web key: main-thread time)`);
if (jsonOut) fs.writeFileSync(jsonOut, JSON.stringify({ native, web, machine: os.cpus()[0].model }, null, 2));
fs.rmSync(work, { recursive: true, force: true });
