#!/usr/bin/env node
// The acceptance runner (README.md): runs scenario files on the Mac app and on the web board VS Code shows, side by side,
// with a hand's pointer, and writes recordings, screenshots and a report to apps/macos/.build-accept/<scenario>/.
//   node apps/macos/tools/accept/run.mjs <scenario.txt>… [--only mac|web] [--video] [--theme warm-ink|ink-wash] [--dark]
//     [--scale 2] [--storage <folder>] [--skip-build] [--debug] [--keep | --attach | --stop]
// --keep leaves both sides running after the scenarios; later runs with --attach go on in them (no build, no start: a
// few seconds per run, for trying out targets and expectations); --stop ends them.
// It prints one line per scenario and side (expectations passed, failed, not checkable) and exits 1 when one failed.
import { execFileSync, spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { build } from "esbuild";
import sharp from "sharp";

const here = import.meta.dirname;
const repo = path.resolve(here, "../../../..");
const mac = path.join(repo, "apps/macos");
const outRoot = path.join(mac, ".build-accept");
const argv = process.argv.slice(2);
const opt = (k) => (argv.includes(k) ? argv[argv.indexOf(k) + 1] : undefined);
const only = opt("--only");
const valued = ["--only", "--storage", "--theme", "--scale"];
const scenarios = argv.filter((a, i) => !a.startsWith("--") && !valued.includes(argv[i - 1]));
// what a scenario needs, named in its own lines so nobody has to remember the flags: "# storage: <folder>" (relative to
// this folder: storage-two; else storage/) and "# theme: <theme>" (ink-wash; else the default). The flags win; scenarios
// run together share one of each, so they must name the same
function declared(key, flag, fallback) {
  const v = [...new Set(scenarios.map((f) => new RegExp(`^# ${key}: *(\\S+)`, "m").exec(fs.readFileSync(f, "utf8"))?.[1] ?? fallback))];
  if (!opt(flag) && v.length > 1) throw new Error(`these scenarios need different ${key}s (${v.map((x) => x ?? "default").join(", ")}): run them apart`);
  return opt(flag) ?? v[0];
}
const storage = path.resolve(opt("--storage") ?? path.join(here, declared("storage", "--storage", "storage") ?? "storage"));
const theme = declared("theme", "--theme", undefined);
// the look under test and the pixels per point of recordings and shots, the same on both sides
const lookEnv = {
  ...(theme ? { ACCEPT_THEME: theme } : {}),
  ...(argv.includes("--dark") ? { ACCEPT_DARK: "1" } : {}),
  ACCEPT_SCALE: opt("--scale") ?? "1",
};
const sides = only ? [only] : ["mac", "web"];
const attach = argv.includes("--attach") || argv.includes("--stop");
const run = (cmd, a, cwd = repo) => execFileSync(cmd, a, { cwd, stdio: "inherit" });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
if (!scenarios.length && !argv.includes("--stop")) throw new Error("usage: run.mjs <scenario.txt>… [--only mac|web] [--video] [--skip-build] [--debug]");
const video = argv.includes("--video");
const config = argv.includes("--debug") ? "debug" : "release";

// ---- build: the driver app (its own name and bundle id, never the app in use) and the web side
fs.mkdirSync(outRoot, { recursive: true });
const app = path.join(outRoot, "CodeBoard Accept.app");
const webBundle = path.join(outRoot, "web.mjs");
// --skip-build skips the web board's builds; the driver and the Note page are always built (both are incremental)
const skip = argv.includes("--skip-build");
if (!attach && !skip && sides.includes("web")) {
  run("npm", ["run", "build", "-w", "@yhnocoder/markdown"]);
  run("npm", ["run", "build", "-w", "@codeboard/board"]);
}
if (!attach && sides.includes("mac")) {
  run("node", ["apps/macos/web/build.mjs"]);  // the Note page of this checkout (cached: a fraction of a second)
  run("swift", ["build", "-c", config, "--product", "Accept"], mac);
  const bin = execFileSync("swift", ["build", "-c", config, "--show-bin-path"], { cwd: mac }).toString().trim();
  fs.rmSync(app, { recursive: true, force: true });
  fs.mkdirSync(path.join(app, "Contents/MacOS"), { recursive: true });
  fs.copyFileSync(path.join(bin, "Accept"), path.join(app, "Contents/MacOS/Accept"));
  fs.cpSync(path.join(mac, "web/dist"), path.join(app, "Contents/Resources/NotePage"), { recursive: true });
}
if (!attach && sides.includes("web")) {
  await build({
    entryPoints: [path.join(here, "web.ts")],
    outfile: webBundle,
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node22",
    banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" },
    logLevel: "warning",
    plugins: [
      {
        name: "npm-external",
        setup(b) {
          b.onResolve({ filter: /^[^./]/ }, (r) =>
            r.path.startsWith("@codeboard/") || r.path.startsWith("node:") ? undefined : { external: true },
          );
        },
      },
    ],
  });
}

/** The driver app's own record of a vault's cameras (CameraStore: under its bundle id, named by FNV-1a of the vault's
 *  path), taken away with the vault; other runs' vaults have files of their own */
function cameraFile(vault) {
  let h = 0xcbf29ce484222325n;
  for (const b of Buffer.from(path.resolve(vault))) h = ((h ^ BigInt(b)) * 0x100000001b3n) & 0xffffffffffffffffn;
  const dir = path.join(os.homedir(), "Library/Application Support/com.example.codeboard.accept/Cameras");
  return path.join(dir, `${h.toString(16).padStart(16, "0")}.json`);
}

// ---- a driver: commands into its FIFO, results from its log ("start n …" / "done n … -> result")
class Driver {
  constructor(side, dir) {
    this.side = side;
    this.dir = dir;
    this.log = path.join(dir, "log.txt");
    this.n = 0;
  }
  async start() {
    fs.rmSync(this.dir, { recursive: true, force: true });
    fs.mkdirSync(this.dir, { recursive: true });
    execFileSync("mkfifo", [path.join(this.dir, "cmd")]);
    this.env = { ...process.env, ...lookEnv, ACCEPT_OUT: this.dir, ACCEPT_FIFO: path.join(this.dir, "cmd"), ACCEPT_REPO: repo };
    if (this.side === "mac") {
      // a vault of its own, imported from the storage folder; the app's own defaults start empty
      this.vault = fs.mkdtempSync(path.join(os.tmpdir(), "accept-vault-"));
      this.plist(this.vault);
      execFileSync("sh", ["-c", "defaults delete com.example.codeboard.accept >/dev/null 2>&1 || true"]);
      Object.assign(this.env, { ACCEPT_VAULT: this.vault, ACCEPT_IMPORT_FROM: storage });
    } else {
      this.copy = fs.mkdtempSync(path.join(os.tmpdir(), "accept-storage-"));
      fs.cpSync(storage, this.copy, { recursive: true });
    }
    await this.spawn();
  }
  async spawn() {
    const outFd = fs.openSync(path.join(this.dir, "stdout.txt"), "a");
    this.proc =
      this.side === "mac"
        ? spawn(path.join(app, "Contents/MacOS/Accept"), [], { env: this.env, stdio: ["ignore", outFd, outFd], detached: true })
        : spawn("node", [webBundle, this.copy, this.dir], { env: this.env, cwd: repo, stdio: ["ignore", outFd, outFd], detached: true });
    this.pid = this.proc.pid;
    // (an exited child stays a zombie that kill(pid, 0) still finds: its exit event is what says it is gone)
    this.exited = false;
    this.proc.on("exit", () => (this.exited = true));
    this.proc.unref();
    await this.until(/driver ready|web ready/, 60000);
    // the Mac app starts on its sidebar (or on the board it had open): open the first board, as a person would
    // (until its canvas is there: a fixed wait sometimes clicked before the sidebar listed the board)
    if (this.side !== "mac") return;
    await this.send("warp 700 500");
    for (let i = 0; ; i++) {
      if ((await this.send("cam")) !== "no canvas") break;
      // (a click now and then has done nothing: then Return on the selected row, then a double-click)
      if (i % 10 === 0) await this.send(["click 90 91", "key return", "dbl 90 91"][(i / 10) % 3]);
      await this.send("wait 300");
      if (i === 90) throw new Error(`mac: the board did not open (${this.dir}/log.txt)`);
    }
    for (const c of ["wait 500", "focus", "move 700 650 200"]) await this.send(c);
  }
  /** Quit and open again on what it had: the Mac app on the same vault and the same defaults (what it saves on quitting:
   *  each board's camera, the open board), the web board on the same storage copy. The log so far is kept as
   *  log-<n>.txt; recordings and shots stay */
  async reopen() {
    await Promise.race([this.send("quit").catch(() => {}), sleep(3000)]);
    for (let t = 0; t < 100 && this.alive(); t++) await sleep(50);
    if (this.alive()) process.kill(this.pid, "SIGTERM");
    this.opened = (this.opened ?? 0) + 1;
    fs.renameSync(this.log, path.join(this.dir, `log-${this.opened}.txt`));
    this.n = 0;
    delete this.env.ACCEPT_IMPORT_FROM;
    await this.spawn();
  }
  plist(vault) {
    fs.writeFileSync(
      path.join(app, "Contents/Info.plist"),
      `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleName</key><string>CodeBoard Accept</string>
  <key>CFBundleIdentifier</key><string>com.example.codeboard.accept</string>
  <key>CodeBoardFirstVault</key><string>${vault}</string>
  <key>CFBundleExecutable</key><string>Accept</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>LSUIElement</key><true/>
  <key>NSPrincipalClass</key><string>NSApplication</string>
  <key>NSHighResolutionCapable</key><true/>
</dict></plist>`,
    );
    run("codesign", ["--force", "--sign", "-", app]);
  }
  alive() {
    if (this.proc) return !this.exited;
    try {
      process.kill(this.pid, 0);
      return true;
    } catch {
      return false;
    }
  }
  /** Why the app went away, from its last words (an uncaught exception, a Swift fatal error) */
  why() {
    const f = path.join(this.dir, "stdout.txt");
    const out = fs.existsSync(f) ? fs.readFileSync(f, "utf8") : "";
    const m = /Terminating app due to uncaught exception[^\n]*|Fatal error:[^\n]*/.exec(out);
    return m ? ` (${m[0].slice(0, 300)})` : "";
  }
  lines() {
    return fs.existsSync(this.log) ? fs.readFileSync(this.log, "utf8").split("\n") : [];
  }
  async until(re, ms) {
    for (let t = 0; t < ms; t += 50) {
      if (!this.alive()) throw new Error(`${this.side} driver exited: see ${this.dir}/stdout.txt`);
      if (this.lines().some((l) => re.test(l))) return;
      await sleep(50);
    }
    throw new Error(`${this.side}: timed out waiting for ${re}`);
  }
  async send(line) {
    // a number that is not one would leave the driver moving towards it for ever
    if (/(^|\s)(NaN|-?Infinity|undefined|nan|inf)(\s|$)/.test(line)) throw new Error(`${this.side}: not a number in "${line}"`);
    if (/^down\b/.test(line)) this.held = true;
    if (/^up\b/.test(line)) this.held = false;
    // without blocking: a FIFO opened to write waits for ever for a reader, so a driver that died (the app crashed) would
    // hang the run here. With no reader the open fails (ENXIO): the driver is gone, or between two reads (it opens the
    // FIFO again after each), so try again while it lives. The driver numbers lines as they arrive, so the number is
    // taken only once this line is in (two sides' lines to one driver, the Mac borrowing where the web draws a thing)
    let fd;
    for (let t = 0; fd === undefined; t += 5) {
      try {
        fd = fs.openSync(path.join(this.dir, "cmd"), fs.constants.O_WRONLY | fs.constants.O_NONBLOCK);
      } catch (e) {
        if (e.code !== "ENXIO") throw e;
        if (!this.alive()) throw new Error(`${this.side} driver exited${this.why()}: see ${this.dir}/stdout.txt`);
        if (t > 30000) throw new Error(`${this.side}: the driver has not read its commands for 30 s`);
        await sleep(5);
      }
    }
    try { fs.writeSync(fd, `${line}\n`); } finally { fs.closeSync(fd); }
    const n = ++this.n;
    const re = new RegExp(`^\\S+ done ${n} `);
    // a line answers within 30 s past the time it asks for (wait, move, drag…): a driver that hangs fails this line soon,
    // not the run half an hour later
    const asked = line.split(" ").slice(1).map(Number).filter((x) => x >= 100 && x <= 60000);
    const limit = 30000 + (asked.length ? Math.max(...asked) : 0) + (/^(stop|rec|quit)\b/.test(line) ? 30000 : 0);
    for (let t = 0; t < limit; t += 20) {
      const l = this.lines().find((x) => re.test(x));
      if (l) return l.includes(" -> ") ? l.slice(l.indexOf(" -> ") + 4) : "";
      if (!this.alive()) throw new Error(`${this.side} driver exited${this.why()}: see ${this.dir}/stdout.txt`);
      await sleep(20);
    }
    throw new Error(`${this.side}: no answer to ${line} within ${limit / 1000} s`);
  }
  async stop() {
    await Promise.race([this.send("quit").catch(() => {}), sleep(1500)]);
    if (this.alive()) process.kill(this.pid, "SIGTERM");
    await sleep(300);
    if (this.alive()) process.kill(this.pid, "SIGKILL");
    for (const d of [this.vault, this.copy]) if (d) fs.rmSync(d, { recursive: true, force: true });
    if (this.vault) fs.rmSync(cameraFile(this.vault), { force: true });
  }
}

// ---- targets: @id is a card or Section on the board as each side has it now, at the middle of its top strip;
// @id+dx,dy is that many board units from its top-left corner. The web board says where its element is; the Mac app's
// place comes from its vault's board file and its camera.
/** The board open in the Mac app: its file in the vault */
async function macBoardFile(d) {
  const at = await d.send("board");
  if (at === "none") throw new Error("mac: no board open");
  return path.join(d.vault, at, "board.json");
}
async function macBoard(d) {
  const b = JSON.parse(fs.readFileSync(await macBoardFile(d), "utf8"));
  return Object.fromEntries([...(b.sections ?? []), ...(b.cards ?? [])].map((c) => [c.id, c]));
}
/** The Mac board once the app has saved it: the file unchanged for 400 ms (at most 3 s) */
async function macSaved(d) {
  const file = await macBoardFile(d);
  let last = -1;
  for (let t = 0; t < 3000; t += 100) {
    const m = fs.statSync(file).mtimeMs;
    if (m === last && t >= 400) break;
    last = m;
    await sleep(100);
  }
  return macBoard(d);
}
/** The ids in the storage folder's boards: `new` is a card on the open board that is not one of them (the last made) */
const storageIds = new Set(
  fs.readdirSync(storage, { recursive: true }).filter((f) => String(f).endsWith(".json") && !String(f).startsWith("cards"))
    .flatMap((f) => JSON.parse(fs.readFileSync(path.join(storage, String(f)), "utf8")).cards?.map((c) => c.id) ?? []),
);
async function idOf(d, id) {
  if (id !== "new") return id;
  const ids =
    d.side === "mac"
      ? JSON.parse(fs.readFileSync(await macBoardFile(d), "utf8")).cards.map((c) => c.id)
      : (await d.send("ids")).split(" ");
  const made = ids.filter((x) => !storageIds.has(x));
  if (!made.length) throw new Error(`${d.side}: no new card`);
  return made[made.length - 1];
}
async function point(d, tok, onBoard = false) {
  // @row:<title>: the Mac app's sidebar row of that board
  if (tok.startsWith("@row:")) {
    const r = await d.send(`row ${tok.slice(5)}`);
    if (!/^-?[\d.]+ -?[\d.]+$/.test(r)) throw new Error(`${d.side}: no sidebar row ${tok.slice(5)}${r === "none" ? "" : ` (${r})`}`);
    return r;
  }
  // @ui.<part>[:anchor][+dx,dy]: a part of the chrome (the ui subjects), its centre by default, offsets in points
  const u = /^@ui\.(\w+)(?::(tl|tr|bl|br|c|t|b|l|r))?(?:\+(-?[\d.]+),(-?[\d.]+))?$/.exec(tok);
  if (u) {
    const r = await d.send(`ui ${u[1]}`);
    if (!/^-?[\d.]+ /.test(r)) throw new Error(`${d.side}: no ${u[1]} in the chrome (${r})`);
    const [x, y, w, h] = r.split(" ").map(Number);
    const [cx, cy] = (await d.send("canvas")).split(" ").map(Number);
    const fx = { tl: 0, l: 0, bl: 0, tr: 1, r: 1, br: 1 }[u[2]] ?? 0.5, fy = { tl: 0, t: 0, tr: 0, bl: 1, b: 1, br: 1 }[u[2]] ?? 0.5;
    return `${(cx + x + w * fx + Number(u[3] ?? 0)).toFixed(1)} ${(cy + y + h * fy + Number(u[4] ?? 0)).toFixed(1)}`;
  }
  const m = /^@([\w-]+)(?::(tl|tr|bl|br|c|t|b|l|r))?(?:\+(-?[\d.]+),(-?[\d.]+))?$/.exec(tok);
  if (!m) throw new Error(`not a target: ${tok}`);
  const [, given, anchor, ox, oy] = m;
  const id = await idOf(d, given);
  const g = await geom(d, id, false, true);
  if (g === "missing") throw new Error(`${d.side}: no card or Section ${id}`);
  if (g === undefined) throw new Error(`${d.side}: ${id} is not readable while a button is held (no accessibility elements)`);
  // the anchor: a corner, an edge's middle or the centre; none: the middle of the top strip (14 board units down)
  const fx = { tl: 0, l: 0, bl: 0, t: 0.5, c: 0.5, b: 0.5, tr: 1, r: 1, br: 1 }[anchor] ?? 0.5;
  const fy = { tl: 0, t: 0, tr: 0, l: 0.5, c: 0.5, r: 0.5, bl: 1, b: 1, br: 1 }[anchor];
  // the Mac app's file has no size for some cards (a Text, Box or code card's height, a Free code card's width…): the
  // web board's, when it runs, is the same card
  const need = [...(fy ? ["h"] : []), ...(g.w === undefined ? ["w"] : [])];
  for (const k of need.filter((k) => g[k] === undefined)) {
    const web = running.find((x) => x.side === "web");
    const wg = web && web !== d ? await geom(web, id) : undefined;
    if (typeof wg !== "object" || !Number.isFinite(wg[k]))
      throw new Error(`${d.side}: the ${k === "h" ? "height" : "width"} of ${id} is not known here${web ? "" : " (run both sides to borrow the web board's)"}; use @${id}+dx,dy from its top left`);
    g[k] = wg[k];
  }
  const base = ox === undefined ? [g.x + g.w * fx, fy === undefined ? g.y + 14 : g.y + g.h * fy] : anchor ? [g.x + g.w * fx, g.y + (g.h ?? 0) * (fy ?? 0)] : [g.x, g.y];
  const [x, y] = [base[0] + Number(ox ?? 0), base[1] + Number(oy ?? 0)];
  if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error(`${d.side}: ${tok} gives no point (${id}: ${JSON.stringify(g)})`);
  const w = await d.send(`where ${x} ${y}`);
  if (!/^-?[\d.]+ -?[\d.]+$/.test(w)) throw new Error(`${d.side}: ${tok} is not on the window (${w})`);
  // a target off the board (on the Mac app's sidebar, outside the window) would press something else
  if (!onBoard) return w;
  const [px, py] = w.split(" ").map(Number);
  const [cx, cy, cw, ch] = (await d.send("canvas")).split(" ").map(Number);
  if (!(px >= cx && py >= cy && px <= cx + cw && py <= cy + ch))
    throw new Error(`${d.side}: ${tok} is at ${px},${py} in the window, off the board (${cx},${cy} ${cw}×${ch}): center on it first`);
  return w;
}
async function resolve(d, line) {
  const out = [];
  // (a target a command presses or moves to must be on the board; plain x y can be anywhere in the window)
  for (const tok of line.split(" ")) out.push(tok.startsWith("@") ? await point(d, tok, true) : tok);
  return out.join(" ");
}
async function cam(d) {
  const r = await d.send("cam");
  if (!/^-?[\d.]/.test(r)) throw new Error(`${d.side}: ${r} (is a board open?)`);
  return r.split(" ").map(Number);
}
/** the middle of the canvas (beside the Mac app's sidebar) */
const center = async (d) => (await cam(d)).slice(3, 5);

/** zoom Z: pinch at the window's middle until the camera is at Z */
async function zoomTo(d, z) {
  const [cx, cy] = await center(d);
  await d.send(`move ${cx} ${cy} 200`);
  for (let i = 0; i < 6; i++) {
    const [, , now] = await cam(d);
    if (Math.abs(now / z - 1) < 0.005) return;
    await d.send(`pinch ${(z / now - 1).toFixed(4)} 8`);
    await d.send("wait 300");
  }
}
/** center @target: two-finger scrolls without momentum until the board point is in the window's middle; how far a
 *  scroll moves the board (sign and acceleration differ by side) is learnt from the scrolls already made */
async function centerOn(d, target) {
  const [cx, cy] = await center(d);
  await d.send(`move ${cx} ${cy} 200`);
  const at = async () => (await point(d, target)).split(" ").map(Number);
  let g = [1, 1];
  for (let i = 0; i < 8; i++) {
    const [x, y] = await at();
    const e = [cx - x, cy - y];
    if (Math.hypot(...e) < 2) return;
    const s = e.map((v, k) => Math.max(-600, Math.min(600, v / g[k])));
    await d.send(`scroll ${s[0].toFixed(1)} ${s[1].toFixed(1)} 12 still`);
    await d.send("wait 250");
    const [x2, y2] = await at();
    const moved = [x2 - x, y2 - y];
    g = g.map((v, k) => (Math.abs(s[k]) > 5 && Math.abs(moved[k]) > 1 ? moved[k] / s[k] : v));
  }
}

// ---- expectations: `expect <subject> <op> <value>`, checked on each side as the scenario runs
//   subjects: <id>.x|y|w|h|right|bottom|section (board units; a card or Section), cam.x|y|zoom, pointer.x|y (board
//   units), ui.<part>.x|y|w|h|right|bottom (the toolbar, the dock and their parts, in points from the board's top
//   left), press (what the last
//   press landed on), focus (where keys go now), hover (the card whose ports show), answer (ms from the last input reaching the app to the first change on screen, the drawn
//   pointer left out; needs a running `rec`)
//   ops: = != < <= > >= ~ (within 2) has lacks; values: a number, a word, another subject (`<id>.bottom`), was, was+N,
//   was-N (the subject at `mark`)
// The Mac app's cards are where its canvas's accessibility elements say (identifier = id) when it has them; otherwise
// they are read from its saved board file, so while a button is held they are not checkable there.
/** A card's or Section's place in board units as this side has it now: x y w h right bottom (and section on the Mac);
 *  undefined while a button is held on the Mac without accessibility elements, "missing" when there is no such item */
/** What the Mac app does not say where it draws (arrow labels, sidenote markers, stickers): their ids */
const borrowedIds = () => {
  const b = storageBoard();
  return new Set([...(b.links ?? []), ...(b.sidenotes ?? []), ...(b.stickers ?? [])].map((x) => x.id));
};
const storageBoard = () =>
  JSON.parse(fs.readFileSync(path.join(storage, fs.readdirSync(storage).find((f) => f.endsWith(".json"))), "utf8"));
async function geom(d, id, needSection = false, aim = false) {
  let g;
  const live = d.side === "mac" && !needSection ? await d.send(`ax ${id}`) : "none";
  if (live !== "none") {
    const [x, y, w, h] = live.split(" ").map(Number);
    g = { x, y, w, h };
  } else if (d.side === "mac") {
    // aiming (a target to move to) takes the file as it is, even mid-drag; checking waits for the app to save
    if (d.held && !aim) return undefined;
    const c = (aim ? await macBoard(d) : await macSaved(d))[id];
    if (!c && borrowedIds().has(id)) {
      // an arrow's label, a sidenote's marker, a sticker: the app does not say where it draws them (no accessibility
      // element with this id yet); the web board's is at the same board point, as near as the two layouts agree
      const web = running.find((x) => x.side === "web");
      const wg = web ? await geom(web, id) : undefined;
      if (typeof wg !== "object") throw new Error(`mac: where ${id} is drawn is not known here (run both sides)`);
      return wg;
    }
    if (!c) return "missing";
    g = { x: c.x, y: c.y, w: c.width, h: c.height ?? undefined, section: c.section ?? c.parent ?? "none" };
  } else {
    const r = await d.send(`rect ${id}`);
    if (r === "none") return "missing";
    const [left, top, w, h] = r.split(" ").map(Number);
    const [ox, oy] = (await d.send("where 0 0")).split(" ").map(Number);
    const [, , z] = await cam(d);
    g = { x: (left - ox) / z, y: (top - oy) / z, w: w / z, h: h / z };
  }
  g.right = g.w === undefined ? undefined : g.x + g.w;
  g.bottom = g.h === undefined ? undefined : g.y + g.h;
  return g;
}
async function subject(d, subj) {
  const [id, field] = subj.split(".");
  // focus: what keys go to now (the Mac's first responder, e.g. OnBoardField's NSTextView; the page's focused element)
  // dialog: the dialog that is up (its text and buttons; none)
  if (subj === "dialog") return (await d.send("dialog")) || "none";
  if (subj === "focus") {
    const r = await d.send("focused");
    return r || "none";
  }
  // hover: the card whose ports show (the Mac app's hovered card, from its CanvasTrace; the web board's ports)
  if (subj === "hover") {
    if (d.side === "web") return d.send("hovered");
    const r = await d.send("trace");
    return r.startsWith("{") ? (JSON.parse(r).hovered ?? "none") : r;
  }
  if (subj === "press") return d.lines().filter((l) => / press /.test(` ${l}`)).pop()?.replace(/^\S+ /, "") ?? "none";
  if (id === "pointer") {
    let [x, y] = (await d.send("pointer")).split(" ").map(Number);
    if (d.side === "web") {
      const [ox, oy] = (await d.send("where 0 0")).split(" ").map(Number);
      const [, , z] = await cam(d);
      [x, y] = [(x - ox) / z, (y - oy) / z];
    }
    return { x, y }[field];
  }
  // ui.<part>.x|y|w|h|right|bottom: the chrome, in points from the board's top left (window units, not board units)
  if (id === "ui") {
    const [, part, f] = subj.split(".");
    const r = await d.send(`ui ${part}`);
    if (r === "none" || r === undefined) return "missing";
    const [x, y, w, h] = r.split(" ").map(Number);
    return { x, y, w, h, right: x + w, bottom: y + h }[f];
  }
  if (id === "cam") {
    const [x, y, zoom] = await cam(d);
    return { x, y, zoom }[field];
  }
  if (!field) throw new Error(`no such subject: ${subj}`);
  if (field === "text") return d.send(`text ${await idOf(d, id)}`);
  const g = await geom(d, await idOf(d, id), field === "section");
  return typeof g === "object" ? g[field] : g;
}
function judge(got, op, want) {
  if (got === undefined) return undefined;
  const n = Number(want), num = typeof got === "number" && !Number.isNaN(n);
  switch (op) {
    case "=": return num ? Math.abs(got - n) < 0.5 : String(got) === want;
    case "!=": return num ? Math.abs(got - n) >= 0.5 : String(got) !== want;
    case "~": return Math.abs(got - n) <= 2;
    case "<": return got < n;
    case "<=": return got <= n;
    case ">": return got > n;
    case ">=": return got >= n;
    case "has": return String(got).includes(want);
    case "lacks": return !String(got).includes(want);
  }
  throw new Error(`no such op: ${op}`);
}
const shown = (v) => (typeof v === "number" ? String(Math.round(v * 10) / 10) : String(v));

/** How long the window took to answer the last input before log line `upto` (ms), from the recorded frames */
async function answerTime(d, upto) {
  const lines = logLines(d).slice(0, upto);
  const last = lines.filter((l) => /^done \d+ (click|dbl|up|key|type|drag|menu|scroll|pinch)\b/.test(l.text)).pop();
  if (!last) return undefined;
  const a = await answered(lines, framesOf(d), last);
  return a === undefined ? undefined : a.first === undefined ? 3000 : (a.first - a.from) * 1000;
}
const logLines = (d) =>
  d.lines().filter(Boolean).map((l) => {
    const i = l.indexOf(" ");
    return { t: Number(l.slice(0, i)), text: l.slice(i + 1) };
  });
/** When the input of command `done` (its log line) reached the app: the button going down (click, dbl, menu), the key
 *  going down (key), the button coming up (up, drag), otherwise the command's start; and the first and last frame that
 *  changed after it, the drawn pointer left out (until nothing changed for 300 ms, within 3 s). Not from the command's
 *  end: an app that answers a key between its down and up has changed before the command ends. */
async function answered(lines, frames, done) {
  const n = /^done (\d+) (\S+)/.exec(done.text);
  const start = lines.findIndex((l) => l.text.startsWith(`start ${n[1]} `));
  const inside = lines.slice(start, lines.indexOf(done) + 1);
  const from = /^(up|drag)$/.test(n[2])
    ? done.t
    : (inside.filter((l) => /^(press|key down) /.test(l.text)).pop() ?? inside[0] ?? done).t;
  const at = frames.findIndex((f) => f.t >= from);
  if (at < 1) return undefined;
  let first, last;
  // (Chromium sends a frame only when the picture changed; the Mac recorder sends every frame)
  for (let i = at; i < frames.length && frames[i].t - from < 3; i++) {
    if (last !== undefined && frames[i].t - last > 0.3) break;
    if (await differ(frames[i - 1], frames[i])) {
      first ??= frames[i].t;
      last = frames[i].t;
    }
  }
  return { from, first, last };
}
function framesOf(d) {
  const frames = [];
  for (const r of fs.readdirSync(d.dir).filter((f) => fs.existsSync(path.join(d.dir, f, "times.txt")))) {
    const rows = fs.readFileSync(path.join(d.dir, r, "times.txt"), "utf8").split("\n").filter(Boolean);
    rows.forEach((row, i) => {
      const [t, x, y] = row.split(" ").map(Number);
      frames.push({ t, x, y, file: path.join(d.dir, r, `f${String(i).padStart(5, "0")}.png`) });
    });
  }
  return frames.sort((a, b) => a.t - b.t);
}
const small = new Map();
const SW = 160, SH = 104; // (coarse on purpose: a blinking caret is not a change)
const pixels = async (f) => {
  if (!small.has(f)) {
    const img = sharp(f);
    const { width, height } = await img.metadata();
    const s = Number(lookEnv.ACCEPT_SCALE);
    small.set(f, { data: await img.resize(SW, SH, { fit: "fill" }).raw().toBuffer(), kx: (SW * s) / width, ky: (SH * s) / height });
  }
  return small.get(f);
};
/** Whether two frames differ, leaving out the pointer the recorder draws in each (its arrow, the ring of a button held
 *  down, the cursor's name beside it) */
async function differ(a, b) {
  const [x, y] = await Promise.all([pixels(a.file), pixels(b.file)]);
  const { kx, ky } = x, ch = x.data.length / (SW * SH);
  // (points from the pointer's tip: the ring and the arrow, then the cursor's name)
  const boxes = [[-12, -12, 13, 21], [14, 15, 100, 31]];
  const masks = [a, b].filter((f) => !Number.isNaN(f.x ?? NaN))
    .flatMap((f) => boxes.map(([l, t, r, btm]) => [(f.x + l) * kx, (f.y + t) * ky, (f.x + r) * kx, (f.y + btm) * ky]));
  let n = 0;
  for (let i = 0; i < x.data.length; i++) {
    if (Math.abs(x.data[i] - y.data[i]) <= 24) continue;
    const p = Math.floor(i / ch), px = p % SW, py = Math.floor(p / SW);
    if (masks.some(([l, t, r, btm]) => px >= Math.floor(l) && px <= Math.ceil(r) && py >= Math.floor(t) && py <= Math.ceil(btm))) continue;
    n++;
  }
  return n > 3;
}

async function cut(d, name, [target, w, h]) {
  const [x, y] = (await point(d, target)).split(" ").map(Number);
  const [ox, oy] = (await d.send("origin")).split(" ").map(Number);
  const [, , z] = await cam(d);
  const s = Number(lookEnv.ACCEPT_SCALE);
  const full = path.join(d.dir, `${name}.png`);
  const meta = await sharp(full).metadata();
  const left = Math.max(0, Math.round((ox + x) * s)), top = Math.max(0, Math.round((oy + y) * s));
  const width = Math.min(meta.width - left, Math.round(Number(w) * z * s));
  const height = Math.min(meta.height - top, Math.round(Number(h) * z * s));
  if (width < 1 || height < 1) return;
  const buf = await sharp(full).extract({ left, top, width, height }).png().toBuffer();
  fs.renameSync(full, path.join(d.dir, `${name}-window.png`));
  fs.writeFileSync(full, buf);
}

// ---- outputs
const fpsOf = (dir) => {
  const t = fs.readFileSync(path.join(dir, "times.txt"), "utf8").split("\n").filter(Boolean).map((l) => Number(l.split(" ")[0]));
  return t.length > 1 ? (t.length - 1) / (t[t.length - 1] - t[0]) : 30;
};
function sideBySide(out, name, have, dirs) {
  const font = "/System/Library/Fonts/Helvetica.ttc";
  const label = (i, side) =>
    `[${i}]scale=-2:720,fps=30,drawtext=fontfile=${font}:text=${side === "mac" ? "Mac" : "VS Code"}:x=12:y=h-36:fontsize=24:fontcolor=red,tpad=stop_mode=clone:stop_duration=3[v${i}]`;
  const ins = have.flatMap((s) => ["-framerate", fpsOf(path.join(dirs[s], name)).toFixed(2), "-i", path.join(dirs[s], name, "f%05d.png")]);
  const f = have.map((s, i) => label(i, s)).join(";");
  const stack = have.length > 1 ? `;[v0][v1]hstack=2:shortest=1,pad=ceil(iw/2)*2:ceil(ih/2)*2[o]` : ";[v0]pad=ceil(iw/2)*2:ceil(ih/2)*2[o]";
  execFileSync("ffmpeg", ["-loglevel", "error", "-y", ...ins, "-filter_complex", f + stack, "-map", "[o]", "-c:v", "libx264", "-pix_fmt", "yuv420p", path.join(out, `${name}.mp4`)]);
}
async function shotPair(out, name, have, dirs) {
  const files = have.map((s) => path.join(dirs[s], `${name}.png`)).filter((f) => fs.existsSync(f));
  if (files.length < 2) return;
  const height = Math.min(...(await Promise.all(files.map(async (f) => (await sharp(f).metadata()).height))));
  const imgs = await Promise.all(files.map((f) => sharp(f).resize({ height }).toBuffer({ resolveWithObject: true })));
  const width = imgs.reduce((a, i) => a + i.info.width, 0);
  let left = 0;
  await sharp({ create: { width, height, channels: 3, background: "#000" } })
    .composite(imgs.map((i) => ({ input: i.data, left: (left += i.info.width) - i.info.width, top: 0 })))
    .png()
    .toFile(path.join(out, `${name}.png`));
}

/** Per side: each command's time, what each press landed on, and for recorded commands how long the window took to
 *  answer (first frame that changed after the command ended) and to settle (no change for 300 ms) */
async function report(d, out) {
  const rows = [];
  const lines = logLines(d);
  const frames = framesOf(d);
  const inputs = { move: 0, click: 0, dbl: 0, drag: 0, down: 0, key: 0, type: 0, scroll: 0, pinch: 0, menu: 0 };
  for (const l of lines) {
    const m = /^start (\d+) (\S+)/.exec(l.text);
    if (m && m[2] in inputs) inputs[m[2]]++;
    if (l.text.startsWith("press ")) rows.push(`  ${l.text}`);
    const done = /^done (\d+) (.*)$/.exec(l.text);
    if (!done || /^(cam|rect|where|hit)\b/.test(done[2])) continue;
    const start = lines.find((x) => x.text.startsWith(`start ${done[1]} `));
    let answer = "";
    if (/^(click|dbl|up|key|type|drag|menu)\b/.test(done[2])) {
      const a = await answered(lines, frames, l);
      if (a) {
        const ms = (t) => ((t - a.from) * 1000).toFixed(0);
        answer = a.first === undefined ? "  no change within 3 s" : `  answered ${ms(a.first)} ms, settled ${ms(a.last)} ms`;
      }
    }
    rows.push(`${((l.t - (start?.t ?? l.t)) * 1000).toFixed(0).padStart(6)} ms  ${done[2]}${answer}`);
  }
  const counts = Object.entries(inputs).filter(([, n]) => n).map(([k, n]) => `${k} ${n}`).join(", ");
  fs.writeFileSync(path.join(out, `report-${d.side}.txt`), `inputs: ${counts}\n\n${rows.join("\n")}\n`);
}

// ---- a kept session (--keep, --attach, --stop)
const sessionFile = path.join(outRoot, "session.json");
function attached() {
  if (!fs.existsSync(sessionFile)) throw new Error("no kept session: run with --keep first");
  const kept = JSON.parse(fs.readFileSync(sessionFile, "utf8"));
  return kept.map((k) => {
    const d = Object.assign(new Driver(k.side, k.dir), k);
    if (!d.alive()) throw new Error(`the kept ${d.side} side is gone: run with --keep again`);
    d.n = d.lines().filter((l) => / done \d+ /.test(l)).length;
    return d;
  });
}
if (argv.includes("--stop")) {
  if (fs.existsSync(sessionFile)) {
    await Promise.all(JSON.parse(fs.readFileSync(sessionFile, "utf8")).map((k) => Object.assign(new Driver(k.side, k.dir), k).stop()));
    fs.rmSync(sessionFile);
  }
  process.exit(0);
}

// ---- scenarios
let failed = false;
let kept;
let running = [];
for (const file of scenarios) {
  const name = path.basename(file).replace(/\.\w+$/, "");
  const out = path.join(outRoot, name);
  if (!attach && !kept) fs.rmSync(out, { recursive: true, force: true });
  fs.mkdirSync(out, { recursive: true });
  const drivers = attach ? (kept ??= attached()) : (kept ?? sides.map((s) => new Driver(s, path.join(out, s))));
  const fresh = !attach && !kept?.started;
  const ds = drivers.map((d) => d.side);
  running = drivers;
  const dirs = Object.fromEntries(drivers.map((d) => [d.side, d.dir]));
  const recs = new Set(), shots = new Set();
  const lines = fs.readFileSync(file, "utf8").split("\n").map((l, i) => ({ n: i + 1, text: l.trim() }));
  // the subjects compared with `was`, taken at each `mark`
  const marked = [...new Set(lines.filter((l) => / was\b/.test(l.text)).map((l) => l.text.replace(/^(mac|web):\s*/, "").split(" ")[1]))];
  // `# known: <why>` (or `# known mac: <why>`, one side): a problem followed elsewhere; its failures are reported but do
  // not fail the run
  const knownOf = (side) =>
    lines.map((l) => /^#\s*known(?:\s+(mac|web))?:\s*(.*)$/.exec(l.text)).find((m) => m && (!m[1] || m[1] === side))?.[2];
  const results = Object.fromEntries(ds.map((s) => [s, []]));
  const was = Object.fromEntries(ds.map((s) => [s, {}]));
  const answers = [];
  try {
    if (fresh) await Promise.all(drivers.map((d) => d.start()));
    if (argv.includes("--keep")) {
      kept = drivers;
      kept.started = true;
      const keep = ({ side, dir, pid, vault, copy, env }) => ({ side, dir, pid, vault, copy, env });
      fs.writeFileSync(sessionFile, JSON.stringify(drivers.map(keep)));
    }
    for (const { n, text: line } of lines) {
      if (!line || line.startsWith("#")) continue;
      const m = /^(mac|web):\s*(.*)$/.exec(line);
      const cmd = m ? m[2] : line;
      const [verb, arg, op, want] = cmd.split(" ");
      if (verb === "rec") recs.add(arg);
      if (verb === "shot") shots.add(arg);
      // shot <name> @target W H: also the board rectangle W × H (board units) from the target, cut out on each side,
      // so the two sides' pictures of one part line up
      const crop = verb === "shot" && cmd.split(" ")[2]?.startsWith("@") ? cmd.split(" ").slice(2) : undefined;
      // a side whose driver exited (the app crashed) failed once, with why; its later lines are not run
      const sent = drivers.filter((d) => (!m || m[1] === d.side) && !d.gone);
      // a line that cannot run (no such card, a height not known) fails as an expectation would, and the run goes on
      await Promise.all(
        sent
          .map((d) => (async () => {
            if (verb === "reopen") return d.reopen();
            if (verb === "zoom") return zoomTo(d, Number(arg));
            if (verb === "center") return centerOn(d, arg);
            if (verb === "locate") {
              // where things are now, once, instead of trying targets: id, board rect, window rect
              const board = storageBoard();
              const ids = cmd.split(" ").slice(1).length ? cmd.split(" ").slice(1) : [...(board.sections ?? []), ...(board.cards ?? [])].map((c) => c.id);
              const rows = [];
              for (const id of ids) {
                const g = await geom(d, id);
                if (typeof g !== "object") { rows.push(`${id}: ${g ?? "n/a"}`); continue; }
                const [wx, wy] = (await d.send(`where ${g.x} ${g.y}`)).split(" ");
                const [, , z] = await cam(d);
                rows.push(`${id}: board ${shown(g.x)},${shown(g.y)} ${shown(g.w)}×${g.h === undefined ? "?" : shown(g.h)}  window ${wx},${wy} ${shown(g.w * z)}×${g.h === undefined ? "?" : shown(g.h * z)}`);
              }
              console.log(`${d.side} locate:\n  ${rows.join("\n  ")}`);
              return;
            }
            if (verb === "mark") {
              for (const s of marked) if (s !== "answer") was[d.side][s] = await subject(d, s);
              return;
            }
            if (verb === "expect") {
              if (arg === "answer") return answers.push({ d, n, cmd, op, want, upto: d.lines().length });
              const got = await subject(d, arg);
              const base = /^was([+-][\d.]+)?$/.exec(want);
              const isSubj = /^(ui\.)?[\w-]+\.(x|y|w|h|right|bottom|zoom)$/.test(want);
              const before = base ? ` (was ${shown(was[d.side][arg])})` : "";
              const other = isSubj ? await subject(d, want) : undefined;
              const v = base ? String(Number(was[d.side][arg]) + Number(base[1] ?? 0)) : isSubj ? other : want;
              const ok = v === undefined ? undefined : judge(got, op, String(v));
              return results[d.side].push({ n, cmd, ok, got: (isSubj ? `${shown(got)} vs ${shown(other)}` : shown(got)) + before });
            }
            if (crop) {
              await d.send(`shot ${arg}`);
              return cut(d, arg, crop);
            }
            const r = await d.send(await resolve(d, cmd));
            if (r) fs.appendFileSync(path.join(out, `results-${d.side}.txt`), `${cmd}\n${r}\n\n`);
          })().catch((e) => {
            if (/driver exited/.test(e.message)) d.gone = true;
            results[d.side].push({ n, cmd, ok: false, got: d.gone ? `${e.message}; the lines after it were not run` : e.message });
          })),
      );
    }
  } finally {
    if (!argv.includes("--keep") && !attach) await Promise.all(drivers.map((d) => d.stop()));
  }
  for (const a of answers) {
    const got = await answerTime(a.d, a.upto);
    results[a.d.side].push({ n: a.n, cmd: a.cmd, ok: judge(got, a.op, a.want), got: got === undefined ? "no frames" : `${Math.round(got)} ms` });
  }
  if (video) {
    for (const r of recs) {
      const have = ds.filter((s) => fs.existsSync(path.join(dirs[s], r, "f00000.png")));
      for (const s of ds.filter((x) => !have.includes(x)))
        console.warn(`${name}: ${s} recorded no frames for ${r} (${path.join(dirs[s], "log.txt")} says why)`);
      if (have.length) sideBySide(out, r, have, dirs);
    }
  }
  for (const s of shots) await shotPair(out, s, ds, dirs);
  for (const d of drivers) await report(d, out);
  // one line per side, then only what failed or could not be checked
  for (const side of ds) {
    const r = results[side].sort((a, b) => a.n - b.n);
    const bad = r.filter((x) => x.ok === false), na = r.filter((x) => x.ok === undefined);
    const known = knownOf(side);
    failed ||= bad.length > 0 && !known;
    const verdict = bad.length ? (known ? `known (${known})` : "FAIL") : known && r.length ? "passes now: remove `# known`" : "ok";
    console.log(`${name} ${side}: ${verdict} ${r.length - bad.length - na.length}/${r.length}${na.length ? `, ${na.length} not checkable` : ""}`);
    for (const x of [...bad, ...na]) console.log(`  ${x.ok === false ? "FAIL" : "n/a "} ${path.basename(file)}:${x.n} ${x.cmd} (got ${x.got})`);
    fs.writeFileSync(path.join(out, `expect-${side}.txt`), r.map((x) => `${x.ok === undefined ? "n/a " : x.ok ? "ok  " : "FAIL"} ${x.n} ${x.cmd} (got ${x.got})`).join("\n") + "\n");
  }
  console.log(`  ${out}${video ? "" : " (recordings: --video)"}`);
}
process.exitCode = failed ? 1 : 0;
