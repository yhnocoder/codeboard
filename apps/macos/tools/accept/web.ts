// The acceptance driver's web side (README.md): the board VS Code shows, on a storage folder's first board, in headless
// Chromium, taking the Mac driver's commands from <out>/cmd and logging to <out>/log.txt the same way.
//   node web.mjs <storage> <out>   (run.mjs bundles and starts it)
import * as fs from "node:fs";
import * as http from "node:http";
import * as path from "node:path";
import type { AddressInfo } from "node:net";
import { recordBoards } from "../../../../packages/tiles/src/record";
import { launch } from "../../../../tools/test/chromium.mjs";

const [storage, out] = process.argv.slice(2);
const repo = process.env.ACCEPT_REPO ?? process.cwd();
const boardDist = path.join(process.env.ACCEPT_WEB ?? repo, "packages/board/dist");
const here = path.join(repo, "apps/macos/tools/accept");
const W = Number(process.env.WEB_W ?? 1000), H = Number(process.env.WEB_H ?? 760);
fs.mkdirSync(out, { recursive: true });
const logf = path.join(out, "log.txt");
const now = () => (performance.now() / 1000).toFixed(3);
const log = (s: string) => fs.appendFileSync(logf, `${now()} ${s}\n`);
const TYPES: Record<string, string> = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".woff2": "font/woff2", ".png": "image/png", ".svg": "image/svg+xml" };
const server = http.createServer((req, res) => {
  const p = decodeURIComponent(new URL(req.url ?? "/", "http://x").pathname);
  const f = p === "/page.html" ? path.join(here, "page.html") : p.startsWith("/board/") ? path.join(boardDist, p.slice(7)) : p.startsWith("/assets/") ? path.join(storage, "assets", p.slice(8)) : undefined;
  if (!f || !fs.existsSync(f) || !fs.statSync(f).isFile()) return void res.writeHead(404).end();
  res.writeHead(200, { "content-type": TYPES[path.extname(f)] ?? "application/octet-stream" });
  fs.createReadStream(f).pipe(res);
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
const rec = await recordBoards(storage, boardDist);
const [, msgs] = [...rec.messages][0];
const browser = await launch();
for (const sig of ["SIGTERM", "SIGINT"]) process.on(sig, () => void browser.close().finally(() => process.exit(0)));
const ctx = await browser.newContext({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
const page = await ctx.newPage();
page.on("pageerror", (e) => log(`pageerror ${e.message}`));
page.on("console", (m) => { if (m.type() === "error") log(`console ${m.text()}`); });
await page.goto(`${base}/page.html`);
await page.waitForFunction(() => (window as any).__booted);
await page.evaluate((ms) => (window as any).__deliver(ms), msgs);
const cdp = await ctx.newCDPSession(page);
let pos = { x: W / 2, y: H / 2 };
let buttons = 0;
let recDir: string | undefined, frame = 0, times = "";
cdp.on("Page.screencastFrame", async (f: any) => {
  await cdp.send("Page.screencastFrameAck", { sessionId: f.sessionId }).catch(() => {});
  if (!recDir) return;
  times += `${now()}\n`;
  fs.writeFileSync(path.join(recDir, `f${String(frame++).padStart(5, "0")}.png`), Buffer.from(f.data, "base64"));
});
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function move(x: number, y: number, ms = 350) {
  const from = { ...pos }, dx = x - from.x, dy = y - from.y, len = Math.hypot(dx, dy);
  const steps = Math.max(2, Math.round(ms / 8)), bend = Math.min(40, len * 0.08) * (Math.random() < 0.5 ? 1 : -1);
  for (let i = 1; i <= steps; i++) {
    const t = i / steps, e = t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2, b = Math.sin(Math.PI * e) * bend;
    const nx = len ? -dy / len : 0, ny = len ? dx / len : 0;
    pos = { x: from.x + dx * e + nx * b, y: from.y + dy * e + ny * b };
    await page.mouse.move(pos.x, pos.y);
    await sleep(8);
  }
  pos = { x, y };
  await page.mouse.move(x, y);
}
// ⌘ is the board's Mod key on a Mac; elsewhere (a Linux run of the web side) the board's Mod is Control
const CMD = process.platform === "darwin" ? "Meta" : "Control";
const mods = (s?: string) => (s ? s.split("+").map((m) => ({ cmd: CMD, shift: "Shift", alt: "Alt", opt: "Alt", ctrl: "Control" })[m] ?? m) : []);
async function hold(ms: string[], f: () => Promise<void>) {
  for (const m of ms) await page.keyboard.down(m);
  await f();
  for (const m of ms.reverse()) await page.keyboard.up(m);
}
/** what type takes: \\n is Return and \\s a space (a scenario line's trailing spaces are trimmed) */
const typed = (s: string) => s.replace(/\\n/g, "\n").replace(/\\s/g, " ");
const keyName: Record<string, string> = { return: "Enter", esc: "Escape", delete: "Backspace", fwddelete: "Delete", left: "ArrowLeft", right: "ArrowRight", up: "ArrowUp", down: "ArrowDown", tab: "Tab", space: "Space", home: "Home", end: "End", pageup: "PageUp", pagedown: "PageDown", f2: "F2" };
/** What a press lands on, as the Mac driver logs it: the element under the pointer and its ancestors' classes */
const hitAt = (x: number, y: number) => page.evaluate(([x, y]) => {
  const out: string[] = [];
  for (let e = document.elementFromPoint(x, y); e && out.length < 6; e = e.parentElement)
    out.push(e.tagName.toLowerCase() + (e.classList.length ? "." + [...e.classList].slice(0, 2).join(".") : "") + ((e as HTMLElement).dataset?.id ? `#${(e as HTMLElement).dataset.id}` : ""));
  return out.join(" < ");
}, [x, y]);
/** find <card> before|mid|after <words>: where the words are on screen in that card, as a person would see them (only
 *  text that is drawn: hidden markers are not), and the point just before, in the middle of or just after them */
function findText([id, mode, text]: string[]) {
  const card = document.querySelector(`.card[data-id="${CSS.escape(id)}"]`);
  if (!card) return "no card";
  const nodes: [Text, number][] = [];
  let all = "";
  const walk = document.createTreeWalker(card, NodeFilter.SHOW_TEXT);
  for (let n = walk.nextNode() as Text | null; n; n = walk.nextNode() as Text | null) {
    const r = document.createRange();
    r.selectNodeContents(n);
    if (!n.parentElement || getComputedStyle(n.parentElement).visibility === "hidden" || !r.getClientRects().length) continue;
    nodes.push([n, all.length]);
    all += n.data;
  }
  const i = all.indexOf(text);
  if (i < 0 || !text) return `not found; read: ${all.slice(0, 300)}`;
  const at = (k: number) => nodes.findLast(([, s]) => s <= k)!;
  const [n0, s0] = at(i), [n1, s1] = at(i + text.length - 1);
  const r = document.createRange();
  r.setStart(n0, i - s0);
  r.setEnd(n1, i + text.length - s1);
  const rs = [...r.getClientRects()].filter((x) => x.width > 0);
  const f = rs[0], l = rs[rs.length - 1];
  const p = mode === "before" ? [f.left, f.top + f.height / 2] : mode === "after" ? [l.right, l.top + l.height / 2] : [(f.left + f.right) / 2, f.top + f.height / 2];
  return p.map((v) => v.toFixed(1)).join(" ");
}
/** caret: where the caret is and what is around it, as the Mac side reads it from the text input system:
 *  "x y h <height> | <12 before>[<selected>]<12 after>", line breaks as ⏎ */
function caretAt() {
  const s = getSelection();
  if (!s?.rangeCount) return "no selection";
  const r = s.getRangeAt(0);
  const ed = r.startContainer.parentElement?.closest("[contenteditable=true], .cm-content") ?? document.body;
  const side = (start: boolean) => {
    const x = document.createRange();
    x.selectNodeContents(ed);
    if (start) x.setEnd(r.startContainer, r.startOffset);
    else x.setStart(r.endContainer, r.endOffset);
    return x.toString();
  };
  const box = [...r.getClientRects()][0] ?? r.getBoundingClientRect();
  const nl = (t: string) => t.replace(/\n/g, "⏎");
  return `${box.left.toFixed(1)} ${box.top.toFixed(1)} h ${box.height.toFixed(0)} | ${nl(side(true).slice(-12))}[${nl(s.toString())}]${nl(side(false).slice(0, 12))}`;
}
/** source <card>: the Note's Markdown as the board last sent it to the host (page.html keeps each card's last), else as
 *  stored */
async function sourceOf(id: string): Promise<string | undefined> {
  const sent = await page.evaluate((id) => (window as any).__saved[id] as string | undefined, id);
  return sent ?? storedCard(id);
}
function storedCard(id: string): string | undefined {
  for (const f of fs.readdirSync(storage).filter((f) => f.endsWith(".json"))) {
    const b = JSON.parse(fs.readFileSync(path.join(storage, f), "utf8"));
    const c = (b.cards ?? []).find((x: { id: string }) => x.id === id);
    if (c) return c.md ?? c.text;
  }
  return undefined;
}
async function pressed(right: boolean) { log(`press ${right ? "right" : "left"} at ${pos.x.toFixed(0)},${pos.y.toFixed(0)} on ${await hitAt(pos.x, pos.y)}`); }
async function run(line: string): Promise<string> {
  const a = line.split(" ").filter(Boolean), d = (i: number, def = 0) => (i < a.length ? Number(a[i]) : def);
  switch (a[0]) {
    case "warp": pos = { x: d(1), y: d(2) }; await page.mouse.move(pos.x, pos.y); break;
    case "move": await move(d(1), d(2), d(3, 350)); break;
    case "down": await pressed(a[1] === "right"); await page.mouse.down({ button: a[1] === "right" ? "right" : "left" }); break;
    case "up": await page.mouse.up({ button: a[1] === "right" ? "right" : "left" }); break;
    case "click": case "dbl":
      if (a.length > 2) await move(d(1), d(2), 300);
      await sleep(60);
      await hold(mods(a[3]), async () => {
        for (let i = 1; i <= (a[0] === "dbl" ? 2 : 1); i++) {
          await pressed(false); await page.mouse.down({ clickCount: i }); await sleep(70); await page.mouse.up({ clickCount: i }); await sleep(90);
        }
      });
      break;
    case "drag":
      await move(d(1), d(2), 300); await sleep(80);
      await hold(mods(a[6]), async () => {
        await pressed(false); await page.mouse.down(); await sleep(80); await move(d(3), d(4), d(5, 600)); await sleep(80); await page.mouse.up();
      });
      break;
    case "scroll": {
      const steps = d(3, 12), cmd = a[4] === "cmd";
      for (let i = 0; i < steps; i++) {
        if (cmd) await hold(["Control"], () => page.mouse.wheel(d(1) / steps, -d(2) / steps));
        else await page.mouse.wheel(-d(1) / steps, -d(2) / steps);
        await sleep(8);
      }
      break;
    }
    case "pinch": {
      // Chrome turns a trackpad pinch into wheel events with ctrlKey
      const steps = d(2, 12), per = Math.log(1 + d(1)) / steps;
      for (let i = 0; i < steps; i++) { await hold(["Control"], () => page.mouse.wheel(0, -per * 100)); await sleep(8); }
      break;
    }
    case "key": { const p = a[1].split("+"); const k = p.pop()!; await page.keyboard.press([...mods(p.join("+")), keyName[k] ?? k].join("+")); break; }
    case "type": for (const ch of typed(line.slice(5))) { if (ch === "\n") await page.keyboard.press("Enter"); else await page.keyboard.insertText(ch); await sleep(35); } break;
    case "keys": for (const ch of typed(line.slice(5))) { await page.keyboard.press(ch === "\n" ? "Enter" : ch === " " ? "Space" : ch); await sleep(35); } break;
    case "ime": {
      const parts = line.slice(4).split("|");
      for (const s of parts.slice(0, -1)) { await cdp.send("Input.imeSetComposition", { text: s, selectionStart: s.length, selectionEnd: s.length }); await sleep(120); }
      await page.keyboard.insertText(parts[parts.length - 1]); break;
    }
    case "wait": await sleep(d(1, 200)); break;
    case "where": return await page.evaluate(([x, y]) => {
      // a probe at the board point inside the world layer: wherever the camera is, its box is that point on screen
      const w = document.querySelector(".world"), p = document.createElement("div");
      if (!w) return "no world";
      p.style.cssText = `position:absolute;left:${x}px;top:${y}px;width:0;height:0`;
      w.appendChild(p);
      const r = p.getBoundingClientRect();
      p.remove();
      return `${r.left.toFixed(1)} ${r.top.toFixed(1)}`;
    }, [d(1), d(2)]);
    case "cam": return await page.evaluate(() => {
      const w = document.querySelector(".world");
      if (!w) return "no world";
      const p = document.createElement("div");
      p.style.cssText = "position:absolute;left:0;top:0;width:100px;height:0";
      w.appendChild(p);
      const r = p.getBoundingClientRect();
      p.remove();
      const z = r.width / 100;
      const b = w.parentElement!.getBoundingClientRect();
      return `${(-r.left / z).toFixed(2)} ${(-r.top / z).toFixed(2)} ${z.toFixed(4)} ${(b.left + b.width / 2).toFixed(1)} ${(b.top + b.height / 2).toFixed(1)}`;
    });
    case "rect": return await page.evaluate((id) => {
      // a card, or a Section's frame (the larger of its two elements: frame and title)
      const els = [...document.querySelectorAll(`.card[data-id="${CSS.escape(id)}"], [data-sect="${CSS.escape(id)}"]`)];
      const r = els.map((e) => e.getBoundingClientRect()).sort((a, b) => b.width * b.height - a.width * a.height)[0];
      return r ? `${r.left.toFixed(1)} ${r.top.toFixed(1)} ${r.width.toFixed(1)} ${r.height.toFixed(1)}` : "none";
    }, a[1]);
    case "find": return await page.evaluate(findText, [a[1], a[2], line.split(" ").slice(3).join(" ")]);
    case "caret": return await page.evaluate(caretAt);
    case "source": return (await sourceOf(a[1])) ?? "none";
    case "hit": return await hitAt(pos.x, pos.y);
    case "menu": await page.mouse.down({ button: "right" }); await page.mouse.up({ button: "right" }); await sleep(200);
      return await page.evaluate(() => [...document.querySelectorAll(".menu, [role=menu]")].map((m) => (m as HTMLElement).innerText).join("\n----\n"));
    case "rec": times = ""; recDir = path.join(out, a[1]); fs.rmSync(recDir, { recursive: true, force: true }); fs.mkdirSync(recDir, { recursive: true }); frame = 0;
      await cdp.send("Page.startScreencast", { format: "png", everyNthFrame: 1 }); break;
    case "stop": {
      await sleep(100); await cdp.send("Page.stopScreencast");
      const n = frame; if (recDir) fs.writeFileSync(path.join(recDir, "times.txt"), times);
      recDir = undefined; times = ""; return `frames ${n}`;
    }
    case "shot": await page.screenshot({ path: path.join(out, `${a[1]}.png`) }); break;
    case "eval": return String(await page.evaluate(line.slice(5)));
    case "posted": return JSON.stringify(await page.evaluate(() => (window as any).__posted.splice(0).map((m: any) => m.type)));
    case "quit": await browser.close(); process.exit(0);
    default: return "unknown command";
  }
  return "";
}
const fifo = path.join(out, "cmd");
let n = 0;
log("web ready");
for (;;) {
  const text = fs.readFileSync(fifo, "utf8");
  for (const l of text.split("\n").filter(Boolean)) {
    n++;
    let r = "";
    log(`start ${n} ${l}`);
    try { r = await run(l); } catch (e) { r = `error ${(e as Error).message}`; }
    // one log line per result: line breaks escaped (run.mjs undoes it)
    log(`done ${n} ${l}${r ? " -> " + r.replace(/\\/g, "\\\\").replace(/\n/g, "\\n") : ""}`);
  }
}
