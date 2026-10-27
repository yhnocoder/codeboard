// Nightly Storybook check (TESTING.md tier 3): opens every story of the static build in test-out/storybook
// (npm run build-storybook) in Playwright's Chromium and fails on anything that goes wrong while it renders.
//   isolated    every story in a fresh iframe, a few pages in parallel
//   sequential  every story one after another in a manager page (a few chunks of the list in parallel), so the preview iframe is reused like when a person clicks
//               through the sidebar; leftovers of one story that break the next (the production build's module order, state
//               that was not reset) only show up here
// A story fails on: a console error, an uncaught page error, a failed request (favicon excepted), an exception in the story or
// its play function, a story that is missing or never finishes. Writes test-out/storybook/result.json, exits 1 on any failure.
// Usage: node tools/test/storybook.mjs [idRegex]      env: JOBS (parallel pages, default 4), SCHEME=light|dark, STORY_TIMEOUT (ms)
import * as fs from "node:fs";
import * as http from "node:http";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { CHROMIUM, CHROMIUM_ARGS } from "./chromium.mjs";

const DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "../../test-out/storybook");
const JOBS = +(process.env.JOBS ?? 4);
const SCHEME = process.env.SCHEME ?? "light";
const TIMEOUT = +(process.env.STORY_TIMEOUT ?? 30000);
// An error thrown after the story reported it rendered (a timer, a late fetch) still counts: wait this long for it
const SETTLE = 300;
const IGNORE_REQUEST = /\/favicon\.(ico|svg)$/;
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css", ".json": "application/json", ".svg": "image/svg+xml",
  ".woff2": "font/woff2", ".woff": "font/woff", ".png": "image/png", ".ico": "image/x-icon", ".map": "application/json", ".wasm": "application/wasm" };

if (!fs.existsSync(path.join(DIR, "index.json"))) { console.error(`${DIR}/index.json not found: run npm run build-storybook first`); process.exit(2); }

function serve() {
  const server = http.createServer((req, res) => {
    let file = path.join(DIR, decodeURIComponent(new URL(req.url, "http://x").pathname));
    if (file.endsWith(path.sep)) file += "index.html";
    if (!file.startsWith(DIR) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404).end(); return; }
    res.writeHead(200, { "content-type": TYPES[path.extname(file)] ?? "application/octet-stream" });
    fs.createReadStream(file).pipe(res);
  });
  return new Promise((ok) => server.listen(0, "127.0.0.1", () => ok({ server, base: `http://127.0.0.1:${server.address().port}` })));
}

// In every frame: record the preview channel's events (the preview sends them to the manager; wrapping emit sees them in place)
const hookChannel = () => {
  window.__sb = [];
  const hook = () => {
    const ch = window.__STORYBOOK_ADDONS_CHANNEL__;
    if (!ch) return setTimeout(hook, 5);
    const emit = ch.emit.bind(ch);
    ch.emit = (ev, ...a) => {
      const e = a[0];
      if (["storyRendered", "playFunctionThrewException", "storyThrewException", "storyErrored", "storyMissing"].includes(ev))
        window.__sb.push({ ev, id: typeof e === "string" ? e : e?.storyId, msg: e?.message ?? e?.title ?? "" });
      return emit(ev, ...a);
    };
  };
  hook();
};

/** Collects what goes wrong in a page; `take()` returns and clears it. */
function watch(page) {
  let errors = [];
  // "Failed to load resource" repeats a response the handlers below report with its URL (and let the favicon through)
  page.on("console", (m) => { if (m.type() === "error" && !/^Failed to load resource/.test(m.text())) errors.push(`console.error: ${m.text()}`); });
  page.on("pageerror", (e) => errors.push(`page error: ${e.message}`));
  page.on("requestfailed", (r) => { if (!IGNORE_REQUEST.test(r.url())) errors.push(`request failed: ${r.url()} (${r.failure()?.errorText})`); });
  page.on("response", (r) => { if (r.status() >= 400 && !IGNORE_REQUEST.test(r.url())) errors.push(`HTTP ${r.status()} ${r.url()}`); });
  return { take: () => { const e = errors; errors = []; return e; } };
}

/** Waits until the story has rendered (play function included) or failed; returns the problems the channel reported. */
async function finished(frame, id, from) {
  const t0 = Date.now();
  for (;;) {
    const log = (await frame.evaluate((n) => window.__sb.slice(n), from).catch(() => [])).filter((e) => e.id === id || !e.id);
    const bad = log.filter((e) => e.ev !== "storyRendered");
    if (bad.length || log.some((e) => e.ev === "storyRendered")) {
      await new Promise((r) => setTimeout(r, SETTLE));
      return bad.map((e) => `${e.ev}: ${e.msg}`);
    }
    if (Date.now() - t0 > TIMEOUT) return [`timeout: not rendered after ${TIMEOUT / 1000}s`];
    await new Promise((r) => setTimeout(r, 25));
  }
}

async function isolated(browser, base, ids) {
  const out = {};
  let next = 0;
  await Promise.all(Array.from({ length: JOBS }, async () => {
    const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
    await page.addInitScript(hookChannel);
    const seen = watch(page);
    while (next < ids.length) {
      const id = ids[next++], t0 = Date.now();
      await page.goto(`${base}/iframe.html?id=${id}&viewMode=story&globals=scheme:${SCHEME}`);
      const problems = await finished(page.mainFrame(), id, 0);
      out[id] = { ok: false, ms: Date.now() - t0, errors: [...seen.take(), ...problems] };
      out[id].ok = !out[id].errors.length;
      if (process.env.VERBOSE) console.log(`isolated ${Object.keys(out).length}/${ids.length} ${id} ${out[id].ms}ms ${out[id].ok ? "ok" : "FAIL"}`);
    }
    await page.close();
  }));
  return out;
}

/** `ids` in order in one manager page; with `warm`, the first story is only visited (the end of the previous chunk) and not recorded. */
async function sequential(browser, base, ids, warm) {
  const page = await browser.newPage({ viewport: { width: 1700, height: 1240 } });
  await page.addInitScript(hookChannel);
  const seen = watch(page);
  await page.goto(`${base}/?path=/story/${ids[0]}&globals=scheme:${SCHEME}`);
  const previewFrame = () => page.frames().find((f) => f.url().includes("iframe.html"));
  while (!previewFrame()) await page.waitForTimeout(50);
  const frame = previewFrame();
  const out = {};
  for (const [i, id] of ids.entries()) {
    const t0 = Date.now();
    const from = i ? await frame.evaluate(() => window.__sb.length) : 0;
    // the manager's router follows the URL: same preview iframe, no reload
    if (i) await page.evaluate((id) => {
      const u = new URL(location.href);
      u.searchParams.set("path", `/story/${id}`);
      history.pushState({}, "", u);
      dispatchEvent(new PopStateEvent("popstate", { state: {} }));
    }, id);
    const problems = await finished(frame, id, from);
    if (warm && !i) { seen.take(); continue; }
    const reloaded = previewFrame() !== frame ? ["the preview iframe reloaded"] : [];
    out[id] = { ok: false, ms: Date.now() - t0, errors: [...seen.take(), ...problems, ...reloaded], after: ids[i - 1] };
    out[id].ok = !out[id].errors.length;
    if (process.env.VERBOSE) console.log(`sequential ${i + 1}/${ids.length} ${id} ${out[id].ms}ms ${out[id].ok ? "ok" : "FAIL"}`);
    if (reloaded.length) break;
  }
  await page.close();
  return out;
}

const { server, base } = await serve();
const index = await (await fetch(`${base}/index.json`)).json();
const re = process.argv[2] && new RegExp(process.argv[2]);
const ids = Object.entries(index.entries).filter(([id, e]) => e.type !== "docs" && (!re || re.test(id))).map(([id]) => id);
const browser = await chromium.launch({ executablePath: CHROMIUM, args: CHROMIUM_ARGS });
const t0 = Date.now();
// The sequential pass is a long chain, mostly waiting: cut it into one contiguous chunk per page and run the chunks beside the
// isolated pages. Each chunk but the first starts with the last story of the one before, so no story loses its predecessor.
const size = Math.ceil(ids.length / JOBS);
const chunks = Array.from({ length: JOBS }, (_, k) => k).filter((k) => k * size < ids.length).map((k) => sequential(browser, base, ids.slice(Math.max(0, k * size - 1), (k + 1) * size), k > 0));
const [iso, ...seqs] = await Promise.all([isolated(browser, base, ids), ...chunks]);
const seq = Object.assign({}, ...seqs);
await browser.close();
server.close();

// Every story must have a result in both passes: a sequential pass that stopped early leaves the rest failing as "not run"
const failures = [];
for (const id of ids) {
  const lines = [];
  for (const [mode, r] of [["isolated", iso[id]], ["sequential", seq[id]]]) {
    if (!r) lines.push([mode, "not run"]);
    else for (const e of r.errors) lines.push([`${mode}${r.after ? `, after ${r.after}` : ""}`, e.split("\n")[0].slice(0, 300)]);
  }
  if (!lines.length) continue;
  console.log(`FAIL ${id}`);
  for (const [mode, e] of lines) console.log(`   [${mode}] ${e}`);
  failures.push({ id, error: `[${lines[0][0]}] ${lines[0][1]}` });
}
const seconds = Math.round((Date.now() - t0) / 1000);
console.log(`${ids.length} stories (${SCHEME}), ${failures.length} failing, ${seconds}s`);
fs.writeFileSync(path.join(DIR, "result.json"), JSON.stringify({ scheme: SCHEME, seconds, stories: ids.length, failures, isolated: iso, sequential: seq }, null, 1));
process.exit(failures.length ? 1 : 0);
