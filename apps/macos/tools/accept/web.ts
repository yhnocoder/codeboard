// The acceptance driver's web side (README.md): the board VS Code shows, on a storage folder's first board, in headless
// Chromium, taking the Mac driver's commands from <out>/cmd and logging to <out>/log.txt the same way. Behind the page
// runs the real host (startHost, as the extension runs it) on a copy of the storage folder: what the board asks it
// (search, sub-boards, shared cards, links…) is answered, and edits are saved there.
//   node web.mjs <storage> <out>   (run.mjs bundles and starts it)
import * as fs from "node:fs";
import * as http from "node:http";
import * as path from "node:path";
import type { AddressInfo } from "node:net";
import * as os from "node:os";
import { Emitter, type BoardToHost, type HostToBoard } from "@codeboard/core";
import { SETTINGS } from "@codeboard/core/settings";
import { startHost, type BoardView } from "@codeboard/host";
import { boardsWorkspace } from "../../../../packages/tiles/src/workspace";
import { launch } from "../../../../tools/test/chromium.mjs";

const [storage, out] = process.argv.slice(2);
const repo = process.env.ACCEPT_REPO ?? process.cwd();
const boardDist = path.join(repo, "packages/board/dist");
const here = path.join(repo, "apps/macos/tools/accept");
const W = Number(process.env.WEB_W ?? 1000), H = Number(process.env.WEB_H ?? 760);
fs.mkdirSync(out, { recursive: true });
const logf = path.join(out, "log.txt");
const now = () => (performance.now() / 1000).toFixed(3);
const log = (s: string) => fs.appendFileSync(logf, `${now()} ${s}\n`);
const TYPES: Record<string, string> = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".woff2": "font/woff2", ".png": "image/png", ".svg": "image/svg+xml" };
const server = http.createServer((req, res) => {
  const p = decodeURIComponent(new URL(req.url ?? "/", "http://x").pathname);
  const f = p === "/page.html" ? path.join(here, "page.html") : p.startsWith("/board/") ? path.join(boardDist, p.slice(7)) : p.startsWith("/file/") && p.slice(5).startsWith(tmp + "/") ? p.slice(5) : undefined;
  if (!f || !fs.existsSync(f) || !fs.statSync(f).isFile()) return void res.writeHead(404).end();
  res.writeHead(200, { "content-type": TYPES[path.extname(f)] ?? "application/octet-stream" });
  fs.createReadStream(f).pipe(res);
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
// the look under test: the theme setting the host sends, light or dark as VS Code's body class says
const LOOK = process.env.ACCEPT_THEME ?? "warm-ink", DARK = process.env.ACCEPT_DARK === "1";

// ---- the host: the storage folder copied in as a workspace's .codeboard (it writes there: edits, sub-boards, caches)
const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "accept-web-")));
const root = path.join(tmp, "ws");
fs.cpSync(storage, path.join(root, ".codeboard"), { recursive: true });
const ws = boardsWorkspace(root, path.join(tmp, "storage"));
// the editor's settings: the look under test
const conf = new Map<string, unknown>([[`codeboard.${SETTINGS.theme.key}`, LOOK]]);
const confChanged = new Emitter<{ affects(key: string): boolean }>();
ws.settings = {
  get: <T>(k: string) => conf.get(k) as T | undefined,
  set: async (k, v) => { conf.set(k, v); confChanged.fire({ affects: (x) => k === x || k.startsWith(`${x}.`) }); },
  onDidChange: confChanged.event,
};
// VS Code's modal questions (Delete Board…): up until a `button` or a key answers them (dialog reads them)
let asking: { text: string; actions: string[]; answer: (a: string | undefined) => void } | undefined;
ws.ui = { ...ws.ui, warn: (text, _o, ...actions) => new Promise((answer) => { asking = { text, actions, answer: (a) => { asking = undefined; answer(a); } }; log(`host asks: ${text} [${actions.join("] [")}]`); }) };
/** The one board view: what the host posts goes to the page once it is set up (theme, light or dark), in order */
class PageView implements BoardView {
  title = "";
  visible = true;
  active = true;
  readonly message = new Emitter<BoardToHost>();
  onMessage = this.message.event;
  onDidActivate = new Emitter<void>().event;
  onDidDispose = new Emitter<void>().event;
  live = false;
  held: HostToBoard[] = [];
  out = Promise.resolve();
  postMessage(m: HostToBoard) {
    // no keys forwarded: VS Code takes those (⌘D…) and sends them back as the same key action; here the board takes them
    if (m.type === "init") m = { ...m, host: { ...m.host, forwardedKeys: [] } };
    log(`host → board ${m.type}${m.type === "reply" ? ` #${m.req}${m.data == null ? " (nothing)" : ""}` : ""}`);
    if (!this.live) return void this.held.push(m);
    this.out = this.out.then(() => page.evaluate((x) => (window as any).__deliver([x]), m as never)).catch((e) => log(`post failed: ${e}`));
  }
  reveal() {}
  async focus() {}
  dispose() {}
  resourceUrl(dir: string) { return `${base}/file${dir}`; }
}
const view = new PageView();
const host = startHost(ws, { globalState: { get: () => undefined, set: async () => {} }, openView: () => view }, { mediaDir: boardDist });
await host.ready;
const metas = await host.store.list();
// ACCEPT_BOARD (part of its id): the storage board to open; else the first by name, as the Mac side opens the first row
// of its sidebar
const meta = metas.find((m) => process.env.ACCEPT_BOARD && m.id.includes(process.env.ACCEPT_BOARD)) ?? [...metas].sort((x, y) => x.name.localeCompare(y.name))[0];
// the host opens no board it cannot read (a file the schema refuses), and says nothing here
if (!meta) throw new Error(`no board in ${storage}: does each board file pass the schema (core's readBoardFile)?`);
const browser = await launch();
for (const sig of ["SIGTERM", "SIGINT"])
  process.on(sig, () => void browser.close().finally(() => { host.dispose(); fs.rmSync(tmp, { recursive: true, force: true }); process.exit(0); }));
const SCALE = Number(process.env.ACCEPT_SCALE ?? 1);
const ctx = await browser.newContext({ viewport: { width: W, height: H }, deviceScaleFactor: SCALE });
// Chrome takes a dispatched wheel's delta in device pixels, so at --scale 2 a bare wheel(160) pans 80 CSS px
const wheel = (dx: number, dy: number) => page.mouse.wheel(dx * SCALE, dy * SCALE);
const page = await ctx.newPage();
page.on("pageerror", (e) => log(`pageerror ${e.message}`));
page.on("console", (m) => { if (m.type() === "error") log(`console ${m.text()}`); });
// what the board asks or tells the host
// (each logged: a request and its reply, by number)
await page.exposeFunction("__toHost", (m: BoardToHost & { req?: number }) => { log(`board → host ${m.type}${m.req !== undefined ? ` #${m.req}` : ""}`); view.message.fire(m); });
await host.hub.show(meta.id, { preserveFocus: true });
await page.goto(`${base}/page.html`);
await page.waitForFunction(() => (window as any).__booted);
// light or dark as VS Code says it; the look itself comes with the host's settings (init's theme), which the board
// applies (applyLook): set here too, the look the board started with stayed on beside it, two looks' rules at once
await page.evaluate((dk) => {
  document.body.className = dk ? "vscode-dark" : "vscode-light";
  document.documentElement.dataset.theme = dk ? "dark" : "light";
}, DARK);
view.live = true;
for (const m of view.held.splice(0)) view.postMessage(m);
await page.waitForFunction(() => document.querySelector(".card"), undefined, { timeout: 30000 }).catch(() => log("no card drawn in 30 s"));
log(`look ${await page.evaluate(() => `${document.documentElement.dataset.look} (html.${document.documentElement.className.split(" ").join(".")})`)}`);
const cdp = await ctx.newCDPSession(page);
let pos = { x: W / 2, y: H / 2 };
let buttons = 0;
let recDir: string | undefined, frame = 0, times = "";
cdp.on("Page.screencastFrame", async (f: any) => {
  await cdp.send("Page.screencastFrameAck", { sessionId: f.sessionId }).catch(() => {});
  if (!recDir) return;
  times += `${now()} ${pos.x.toFixed(0)} ${pos.y.toFixed(0)}\n`;
  fs.writeFileSync(path.join(recDir, `f${String(frame++).padStart(5, "0")}.png`), Buffer.from(f.data, "base64"));
});
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function move(x: number, y: number, ms = 350) {
  const from = { ...pos }, dx = x - from.x, dy = y - from.y, len = Math.hypot(dx, dy);
  const bend = Math.min(40, len * 0.08) * (Math.random() < 0.5 ? 1 : -1);
  // by the clock, a step every 8 ms or as soon as the last is handled: the move takes the time asked (as the Mac side's)
  const start = performance.now();
  for (let t = 0; (t = (performance.now() - start) / Math.max(ms, 1)) < 1; ) {
    const e = t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2, b = Math.sin(Math.PI * e) * bend;
    const nx = len ? -dy / len : 0, ny = len ? dx / len : 0;
    pos = { x: from.x + dx * e + nx * b, y: from.y + dy * e + ny * b };
    await page.mouse.move(pos.x, pos.y);
    await sleep(8);
  }
  pos = { x, y };
  await page.mouse.move(x, y);
}
const mods = (s?: string) => (s ? s.split("+").map((m) => ({ cmd: "Meta", shift: "Shift", alt: "Alt", opt: "Alt", ctrl: "Control" })[m] ?? m) : []);
async function hold(ms: string[], f: () => Promise<void>) {
  for (const m of ms) await page.keyboard.down(m);
  await f();
  for (const m of ms.reverse()) await page.keyboard.up(m);
}
/** What shift makes of the other keys (a US layout), as the Mac driver's */
const shifted: Record<string, string> = { "`": "~", "1": "!", "2": "@", "3": "#", "4": "$", "5": "%", "6": "^", "7": "&", "8": "*", "9": "(", "0": ")", "-": "_", "=": "+", "[": "{", "]": "}", "\\": "|", ";": ":", "'": '"', ",": "<", ".": ">", "/": "?" };
/** The keys of the characters shift changes, by code: Playwright makes "Shift+/" a "/" but "Shift+Slash" a "?" */
const keyCode: Record<string, string> = { "`": "Backquote", "-": "Minus", "=": "Equal", "[": "BracketLeft", "]": "BracketRight", "\\": "Backslash", ";": "Semicolon", "'": "Quote", ",": "Comma", ".": "Period", "/": "Slash", ...Object.fromEntries([..."0123456789"].map((d) => [d, `Digit${d}`])) };
const keyName: Record<string, string> = { return: "Enter", esc: "Escape", delete: "Backspace", fwddelete: "Delete", left: "ArrowLeft", right: "ArrowRight", up: "ArrowUp", down: "ArrowDown", tab: "Tab", space: "Space", home: "Home", end: "End", pageup: "PageUp", pagedown: "PageDown", f2: "F2" };
/** What a press lands on, as the Mac driver logs it: the element under the pointer and its ancestors' classes */
const hitAt = (x: number, y: number) => page.evaluate(([x, y]) => {
  const out: string[] = [];
  for (let e = document.elementFromPoint(x, y); e && out.length < 6; e = e.parentElement)
    out.push(e.tagName.toLowerCase() + (e.classList.length ? "." + [...e.classList].slice(0, 2).join(".") : "") + ((e as HTMLElement).dataset?.id ? `#${(e as HTMLElement).dataset.id}` : ""));
  return out.join(" < ");
}, [x, y]);
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
        if (cmd) await hold(["Control"], () => wheel(d(1) / steps, -d(2) / steps));
        else await wheel(-d(1) / steps, -d(2) / steps);
        await sleep(8);
      }
      // the fingers lift moving: the momentum macOS sends after a trackpad swipe, as more wheel events (as Chrome gets
      // them); `still`: they stopped first, nothing more
      if (!cmd && a[4] !== "still") {
        let mx = d(1) / steps, my = d(2) / steps;
        for (let i = 0; i < 24; i++) { mx *= 0.88; my *= 0.88; await wheel(-mx, -my); await sleep(8); }
      }
      break;
    }
    case "pinch": {
      // Chrome turns a trackpad pinch into wheel events with ctrlKey
      const steps = d(2, 12), per = Math.log(1 + d(1)) / steps;
      for (let i = 0; i < steps; i++) { await hold(["Control"], () => wheel(0, -per * 100)); await sleep(8); }
      break;
    }
    case "key": if (asking && /^(esc|return)$/.test(a[1])) { log(`key ${a[1]} to the host's question`); asking.answer(a[1] === "return" ? asking.actions[0] : undefined); break; } { log(`key down ${a[1]} at ${pos.x.toFixed(0)},${pos.y.toFixed(0)}`); const half = a[1].endsWith(":down") ? "down" : a[1].endsWith(":up") ? "up" : ""; const p = a[1].replace(/:(down|up)$/, "").split("+"); const k = p.pop()!; const name = [...mods(p.join("+")), keyName[k] ?? keyCode[k] ?? k].join("+"); if (half === "down") await page.keyboard.down(name); else if (half === "up") await page.keyboard.up(name); else await page.keyboard.press(name); break; }
    // keys: key by key, as typed (a character shift makes, like ?, with shift held, as a person types it)
    case "keys": for (const ch of line.slice(5)) {
      const base = Object.entries(shifted).find(([, v]) => v === ch)?.[0];
      await page.keyboard.press(base ? `Shift+${keyCode[base] ?? base}` : ch === " " ? "Space" : ch); await sleep(30);
    } break;
    // dialog: the board's dialog that is up (its text and buttons); button <title>: click that button in it
    case "dialog": if (asking) return `app-modal: ${asking.text} [${asking.actions.join("] [")}] [Cancel ⎋]`; return await page.evaluate(() => {
      const d = [...document.querySelectorAll<HTMLElement>("[role=dialog], [role=alertdialog]")].find((e) => e.offsetParent);
      if (!d) return "none";
      const buttons = [...d.querySelectorAll("button")].map((b) => (b.textContent ?? "").trim()).filter(Boolean);
      return `dialog: ${d.innerText.split("\n").slice(0, 4).join(" | ")} [${buttons.join("] [")}]`;
    });
    case "button": {
      const title = line.slice(7);
      if (asking) { asking.answer(asking.actions.includes(title) ? title : undefined); break; }
      const r = await page.evaluate((title) => {
        const d = [...document.querySelectorAll<HTMLElement>("[role=dialog], [role=alertdialog]")].find((e) => e.offsetParent);
        const b = d && [...d.querySelectorAll("button")].find((x) => (x.textContent ?? "").trim() === title)?.getBoundingClientRect();
        return b && { x: b.left + b.width / 2, y: b.top + b.height / 2 };
      }, title);
      if (!r) return `no button ${title}`;
      await move(r.x, r.y, 250); await pressed(false); await page.mouse.down(); await sleep(70); await page.mouse.up();
      break;
    }
    case "type": for (const ch of line.slice(5).replace(/\\n/g, "\n")) { if (ch === "\n") await page.keyboard.press("Enter"); else await page.keyboard.insertText(ch); await sleep(35); } break;
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
      // or an arrow's label
      const q = CSS.escape(id);
      const els = [...document.querySelectorAll(`.card[data-id="${q}"], [data-sect="${q}"]`)];
      if (!els.length) els.push(...document.querySelectorAll(`[data-link="${q}"] .vlabel`));
      // a sidenote's marker (the badge that lists it), a sticker
      if (!els.length) els.push(...[...document.querySelectorAll<HTMLElement>(".snb[data-notes]")].filter((b) => b.dataset.notes!.split(",").includes(id)));
      if (!els.length) els.push(...document.querySelectorAll(`[data-sticker="${q}"]`));
      const r = els.map((e) => e.getBoundingClientRect()).sort((a, b) => b.width * b.height - a.width * a.height)[0];
      return r ? `${r.left.toFixed(1)} ${r.top.toFixed(1)} ${r.width.toFixed(1)} ${r.height.toFixed(1)}` : "none";
    }, a[1]);
    case "ui": return await page.evaluate((name) => {
      // a part of the chrome (Chrome.tsx), in px from the board's top left: x y width height
      const board = document.querySelector(".world")?.parentElement?.getBoundingClientRect();
      const pill = (g: string) => document.querySelector<HTMLElement>(`.${g} > .pill`);
      const at = (r: { left: number; top: number; width: number; height: number } | undefined) =>
        r && board ? `${(r.left - board.left).toFixed(1)} ${(r.top - board.top).toFixed(1)} ${r.width.toFixed(1)} ${r.height.toFixed(1)}` : "none";
      const box = (sel: string) => document.querySelector(sel)?.getBoundingClientRect();
      const group = (n: string) => (n.startsWith("bar") ? "bbar" : "dock");
      switch (name) {
        case "bar": case "dock": return at(pill(group(name))?.getBoundingClientRect());
        // the stroke's solid body (state/ink.ts barSvg: 14 to 372 of 400, stretched over the pill) under Ink Wash's
        // --ink-bar; the pill itself where the pill is its own background
        case "barink": case "dockink": {
          const p = pill(group(name));
          if (!p) return "none";
          const r = p.getBoundingClientRect();
          const ink = getComputedStyle(p, "::before").backgroundImage.includes("svg");
          return at(ink ? { left: r.left + (r.width * 14) / 400, top: r.top, width: (r.width * 358) / 400, height: r.height } : r);
        }
        // where the board under it is blurred: the pill (its ::before in Ink Wash), or no width
        case "barblur": case "dockblur": {
          const p = pill(group(name));
          if (!p) return "none";
          const r = p.getBoundingClientRect();
          const f = (st: CSSStyleDeclaration) => st.backdropFilter && st.backdropFilter !== "none";
          return f(getComputedStyle(p)) || f(getComputedStyle(p, "::before")) ? at(r) : at({ left: r.left, top: r.top, width: 0, height: 0 });
        }
        // the brush resting on the bar (.bbar .pill::after): its box turned by its rotate, about its middle
        case "brush": {
          const p = pill("bbar");
          if (!p) return "none";
          const st = getComputedStyle(p, "::after");
          if (st.content === "none" || st.backgroundImage === "none") return "none";
          const r = p.getBoundingClientRect(), w = parseFloat(st.width), h = parseFloat(st.height);
          const cx = r.right - parseFloat(st.right) - w / 2, cy = r.top + parseFloat(st.top) + h / 2;
          const a = (parseFloat(st.rotate) || 0) * (Math.PI / 180);
          const bw = Math.abs(w * Math.cos(a)) + Math.abs(h * Math.sin(a)), bh = Math.abs(w * Math.sin(a)) + Math.abs(h * Math.cos(a));
          return at({ left: cx - bw / 2, top: cy - bh / 2, width: bw, height: bh });
        }
        case "more": return at(box('.bbar [aria-label="More"]'));
        case "shelf": return at(box(".dock .shelf-btn"));
        case "zoomout": return at(box('.dock [aria-label="Zoom Out"]'));
        case "zoom": return at(box(".dock .zoom"));
        case "zoomin": return at(box('.dock [aria-label="Zoom In"]'));
        case "fit": return at(box('.dock [aria-label="Fit to Window"]'));
        case "questions": return at(box(".dock .qlist-btn"));
      }
      return "none";
    }, a[1]);
    // the card's words as the board shows them; the ids of the cards on it
    case "text": return await page.evaluate((id) => (document.querySelector(`.card[data-id="${CSS.escape(id)}"]`) as HTMLElement | null)?.innerText.replace(/\s+/g, " ").trim() ?? "none", a[1]);
    case "ids": return await page.evaluate(() => [...document.querySelectorAll(".card[data-id]")].map((e) => e.getAttribute("data-id")).join(" "));
    case "canvas": return `0 0 ${W} ${H}`;
    // the card whose ports show: only the hovered card's ports get their sizes (state/hover.ts portStyle), the rest hide
    case "hovered": return await page.evaluate(() => {
      const p = [...document.querySelectorAll<HTMLElement>(".eport, .lport")].find((e) => e.style.getPropertyValue("--uv"));
      return p?.closest<HTMLElement>(".card[data-id]")?.dataset.id ?? "none";
    });
    case "focused": return await page.evaluate(() => {
      // the focused element and its ancestors, as hit describes them
      const out: string[] = [];
      for (let e = document.activeElement; e && e !== document.body && out.length < 6; e = e.parentElement)
        out.push(e.tagName.toLowerCase() + [...e.classList].map((c) => `.${c}`).join(""));
      return out.join(" < ") || "body";
    });
    case "hit": return await hitAt(pos.x, pos.y);
    case "pointer": return `${pos.x.toFixed(1)} ${pos.y.toFixed(1)}`;
    case "origin": return "0 0";
    case "menu": await page.mouse.down({ button: "right" }); await page.mouse.up({ button: "right" }); await sleep(200);
      return await page.evaluate(() => [...document.querySelectorAll(".menu, [role=menu]")].map((m) => (m as HTMLElement).innerText).join("\n----\n"));
    case "pick": {
      // pick One/Two: move to each item as a person would (a submenu opens on the way) and click the last
      const levels = line.slice(5).split("/");
      for (const [i, label] of levels.entries()) {
        const r = await page.evaluate((label) => {
          const items = [...document.querySelectorAll<HTMLElement>(".ctx.open [role^=menuitem]")].reverse();
          const b = items.find((x) => x.querySelector(".lb")?.textContent?.trim() === label)?.getBoundingClientRect();
          return b && { x: b.left + b.width / 2, y: b.top + b.height / 2 };
        }, label);
        if (!r) return `no item ${label}`;
        await move(r.x, r.y, 250);
        if (i < levels.length - 1) { await sleep(300); continue; }
        await pressed(false); await page.mouse.down(); await sleep(70); await page.mouse.up();
      }
      return `picked ${line.slice(5)}`;
    }
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
    case "quit": await browser.close(); host.dispose(); await host.flush(); fs.rmSync(tmp, { recursive: true, force: true }); process.exit(0);
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
    log(`done ${n} ${l}${r ? " -> " + r : ""}`);
  }
}
