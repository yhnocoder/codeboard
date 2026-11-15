#!/usr/bin/env node
// The acceptance runner (README.md): runs scenario files on the Mac app and on the web board VS Code shows, side by side,
// with a hand's pointer, and writes recordings, screenshots and a report to apps/macos/.build-accept/<scenario>/.
//   node apps/macos/tools/accept/run.mjs <scenario.txt>… [--only mac|web] [--video] [--theme warm-ink|ink-wash] [--dark]
//     [--scale 2] [--storage <folder>] [--web <checkout>] [--mac app|demo] [--skip-build] [--debug | --release]
//     [--keep | --attach | --stop]
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

const valued = ["--only", "--storage", "--theme", "--scale", "--web", "--mac"];
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
// "# only: mac": a scenario of what only the Mac app has (its sidebar, several boards)
const only = declared("only", "--only", undefined);
// the look under test and the pixels per point of recordings and shots, the same on both sides
const lookEnv = {
  ...(theme ? { ACCEPT_THEME: theme } : {}),
  ...(argv.includes("--dark") ? { ACCEPT_DARK: "1" } : {}),
  ACCEPT_SCALE: opt("--scale") ?? "1",
};
// --mac demo: the Mac side is the native Markdown editor alone (MarkdownDemo, run in the driver: ACCEPT_APP=demo) on
// the one Note card the scenario aims at, instead of the app; targets are placed from the demo's report and source reads
// its saved file
const demo = opt("--mac") === "demo";
// --web <checkout>: the web side draws that checkout's board (a worktree of the latest main: the VS Code version to beat)
const webRepo = path.resolve(opt("--web") ?? repo);
const sides = only ? [only] : ["mac", "web"];
const attach = argv.includes("--attach") || argv.includes("--stop");
const run = (cmd, a, cwd = repo) => execFileSync(cmd, a, { cwd, stdio: "inherit" });
// the Command Line Tools have no SwiftUI macro plugin (the app's @State does not compile): use Xcode's toolchain when
// xcode-select points there and Xcode is installed
if (!process.env.DEVELOPER_DIR && fs.existsSync("/Applications/Xcode.app")) {
  const dev = execFileSync("xcode-select", ["-p"]).toString().trim();
  if (dev.startsWith("/Library/Developer/CommandLineTools")) process.env.DEVELOPER_DIR = "/Applications/Xcode.app/Contents/Developer";
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
if (!scenarios.length && !argv.includes("--stop")) throw new Error("usage: run.mjs <scenario.txt>… [--only mac|web] [--video] [--skip-build] [--debug | --release]");
const video = argv.includes("--video");
// --ci: what continuous integration runs: function only, nothing timed (no recording, `expect answer` not checked), the
// driver a debug build, and three shots of each scenario on each side (ci-1-start, ci-2-middle, ci-3-end) to look at
const ci = argv.includes("--ci");
// the driver's build: debug (an app change builds in seconds) unless what is measured needs the app as people get it,
// release (a change takes one to two minutes): with --release, or when a scenario records (rec) or times (expect answer)
const timed = scenarios.some((f) => /^(\w+:\s*)?(rec |expect answer)/m.test(fs.readFileSync(f, "utf8")));
const config = !ci && (argv.includes("--release") || (timed && !argv.includes("--debug"))) ? "release" : "debug";
if (!attach && scenarios.length) console.log(`driver: ${config} build${config === "release" && !argv.includes("--release") ? " (a scenario records or times)" : ""}`);

// ---- build: the driver app (its own name and bundle id, never the app in use) and the web side
fs.mkdirSync(outRoot, { recursive: true });
const app = path.join(outRoot, demo ? "Markdown Accept.app" : "CodeBoard Accept.app");
// the web side as the --web checkout has it: its packages bundled, its node_modules at run time (a checkout on another
// branch has another board version and host)
const webBundle = path.join(webRepo, "node_modules/.accept/web.mjs");
// --skip-build skips the web board's builds; the driver and the Note page are always built (both are incremental)
const skip = argv.includes("--skip-build");
if (!attach && !skip && sides.includes("web")) {
  run("npm", ["run", "build", "-w", "@yhnocoder/markdown"], webRepo);
  run("npm", ["run", "build", "-w", "@codeboard/board"], webRepo);
}
if (!attach && sides.includes("mac")) {
  // the Note page of this checkout (cached: a fraction of a second), or the demo's assets
  run("node", [demo ? "apps/macos/tools/markdown/assets.mjs" : "apps/macos/web/build.mjs"]);
  run("swift", ["build", "-c", config, "--product", "Accept"], mac);
  const bin = execFileSync("swift", ["build", "-c", config, "--show-bin-path"], { cwd: mac }).toString().trim();
  fs.rmSync(app, { recursive: true, force: true });
  fs.mkdirSync(path.join(app, "Contents/MacOS"), { recursive: true });
  fs.copyFileSync(path.join(bin, "Accept"), path.join(app, "Contents/MacOS/Accept"));
  // the demo's fonts and formula engines (tools/markdown/make-demo.sh); the app's Note page
  if (demo) fs.cpSync(path.join(mac, ".build-markdown"), path.join(app, "Contents/Resources/Assets"), { recursive: true });
  else fs.cpSync(path.join(mac, "web/dist"), path.join(app, "Contents/Resources/NotePage"), { recursive: true });
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
          // web.ts's paths into the repository (the tile recorder, the browser) taken from the --web checkout
          b.onResolve({ filter: /^\.\.\// }, (r) => {
            if (r.importer !== path.join(here, "web.ts")) return undefined;
            const abs = path.resolve(here, r.path);
            return b.resolve(`./${path.relative(repo, abs)}`, { resolveDir: webRepo, kind: r.kind });
          });
          b.onResolve({ filter: /^[^./]/ }, (r) => {
            if (r.path.startsWith("node:")) return undefined;
            if (!r.path.startsWith("@codeboard/")) return { external: true };
            // web.ts's own imports from the --web checkout; theirs resolve beside them
            if (r.importer !== path.join(here, "web.ts")) return undefined;
            return b.resolve(r.path, { resolveDir: webRepo, kind: r.kind });
          });
        },
      },
    ],
  });
}

/** The driver app's own record of a vault's cameras (CameraStore: under its bundle id, named by FNV-1a of the vault's
 *  path), taken away with the vault; other runs' vaults have files of their own */
function cameraFile(id, vault) {
  let h = 0xcbf29ce484222325n;
  for (const b of Buffer.from(path.resolve(vault))) h = ((h ^ BigInt(b)) * 0x100000001b3n) & 0xffffffffffffffffn;
  const dir = path.join(os.homedir(), "Library/Application Support", id, "Cameras");
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
    this.env = { ...process.env, ...lookEnv, ACCEPT_OUT: this.dir, ACCEPT_FIFO: path.join(this.dir, "cmd"), ACCEPT_REPO: repo, ACCEPT_WEB: webRepo };
    if (this.side === "mac" && demo) {
      // the card's Markdown in a folder of its own with the storage's assets beside it (images are read relative to it)
      this.copy = fs.mkdtempSync(path.join(os.tmpdir(), "accept-demo-"));
      // the cards the scenario names, in order: the first opens the demo, a second below it (--second)
      for (const id of this.cards) {
        const c = boardCards()[id];
        if (!c) throw new Error(`demo: no card ${id} in ${storage}`);
        fs.writeFileSync(path.join(this.copy, `${id}.md`), c.md ?? "");
      }
      if (fs.existsSync(path.join(storage, "assets"))) fs.cpSync(path.join(storage, "assets"), path.join(this.copy, "assets"), { recursive: true });
      this.saved = path.join(this.copy, "saved.md");
      this.place = path.join(this.copy, "report.json");
            const width = String(boardPlace()[this.card]?.w ?? 360);
      const args = [path.join(this.copy, `${this.card}.md`), "--width", width, "--save-to", this.saved, "--report", this.place];
      if (this.cards[1]) args.push("--second", path.join(this.copy, `${this.cards[1]}.md`));
      // / Image takes the storage's first picture, so no Open panel ever comes up
      const pic = fs.existsSync(path.join(this.copy, "assets")) && fs.readdirSync(path.join(this.copy, "assets")).find((f) => /\.(png|jpe?g|gif)$/i.test(f));
      if (pic) args.push("--pick-image", path.join(this.copy, "assets", pic));
      Object.assign(this.env, { ACCEPT_APP: "demo", ACCEPT_DEMO_ARGS: JSON.stringify(args) });
      if (this.onScreen) this.env.ACCEPT_ONSCREEN = "1";
    }
    if (this.side === "mac") {
      // a vault of its own, imported from the storage folder; the app's own defaults start empty
      this.vault = fs.mkdtempSync(path.join(os.tmpdir(), "accept-vault-"));
      // and an identity of its own, so its defaults (the vault and tabs it reopens), cameras, caches and web data are this
      // run's alone: with one id for every run, a run in another clone that quit later left its vault for this one to
      // open, on cameras that were not this one's
      this.id = `com.example.codeboard.accept.${Math.random().toString(36).slice(2, 8)}`;
      this.plist(this.vault);
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
        : spawn("node", [webBundle, this.copy, this.dir], { env: this.env, cwd: webRepo, stdio: ["ignore", outFd, outFd], detached: true });
    this.pid = this.proc.pid;
    // (an exited child stays a zombie that kill(pid, 0) still finds: its exit event is what says it is gone)
    // (this process's: one before it that was told to go and exits late must not mark the new one gone)
    this.exited = false;
    const proc = this.proc;
    proc.on("exit", () => { if (this.proc === proc) this.exited = true; });
    this.proc.unref();
    await this.until(/driver ready|web ready/, 60000);
    // the Mac app starts on its sidebar (or on the board it had open): open the first board, as a person would
    // (until its canvas is there: a fixed wait sometimes clicked before the sidebar listed the board)
    if (this.side !== "mac") return;
    if (demo) {
      // the demo shows its card at once (⌥⌘0 lays the card out again in the window's new size, and the demo reports
      // where it is); on screen (real-use) it is left as it opens: its size, its inspector
      const begin = this.onScreen ? ["warp 500 400", "wait 1500", "focus", "move 300 500 200"]
        : ["warp 700 500", "wait 1000", "focus", "key cmd+alt+0", "wait 300", "move 700 650 200"];
      for (const c of begin) await this.send(c);
      // the demo's Inspector shows its own process figures, which tick on their own: no answer of the Note's
      this.ignore = [];
      const r = await this.send("frame Inspector");
      if (/^[\d.]+ [\d.]+ [\d.]+ [\d.]+$/.test(r)) this.ignore.push(r.split(" ").map(Number));
      return;
    }
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
    const hung = this.alive();
    if (hung) process.kill(this.pid, "SIGTERM");
    // what the app kept for the next start (its cameras), in the log of the run that ends: why a camera did not come back
    const kept = !this.vault ? "(web)" : fs.existsSync(cameraFile(this.id, this.vault)) ? fs.readFileSync(cameraFile(this.id, this.vault), "utf8").replace(/\s+/g, "") : "none";
    fs.appendFileSync(this.log, `reopen: ${hung ? "did not quit in 5 s, terminated" : "quit"}; cameras kept ${kept}\n`);
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
  <key>CFBundleName</key><string>${demo ? "Markdown Accept" : "CodeBoard Accept"}</string>
  <key>CFBundleIdentifier</key><string>${this.id}</string>
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
      // a result of more than one line (a menu's items) comes on one: line breaks written \\n, backslashes \\\\
      if (l) return l.includes(" -> ") ? l.slice(l.indexOf(" -> ") + 4).replace(/\\(\\|n)/g, (_, c) => (c === "n" ? "\n" : "\\")) : "";
      if (!this.alive()) throw new Error(`${this.side} driver exited${this.why()}: see ${this.dir}/stdout.txt`);
      await sleep(20);
    }
    throw new Error(`${this.side}: no answer to ${line} within ${limit / 1000} s`);
  }
  async stop() {
    // no driver started (start threw): writing to its FIFO would block with no reader
    if (!this.proc) return;
    await Promise.race([this.send("quit").catch(() => {}), sleep(1500)]);
    if (this.alive()) process.kill(this.pid, "SIGTERM");
    await sleep(300);
    if (this.alive()) process.kill(this.pid, "SIGKILL");
    // the vault, its own trash (what the app deleted goes there, never to the person's Trash) and the web's copy
    for (const d of [this.vault, this.vault && `${this.vault}-trash`, this.copy]) if (d) fs.rmSync(d, { recursive: true, force: true });
    // what the app kept under its identity: its defaults, cameras, caches, web data
    if (this.id) {
      execFileSync("sh", ["-c", `defaults delete ${this.id} >/dev/null 2>&1 || true`]);
      const lib = path.join(os.homedir(), "Library");
      for (const d of ["Preferences/" + this.id + ".plist", "Application Support/" + this.id, "Caches/" + this.id, "WebKit/" + this.id, "HTTPStorages/" + this.id, "HTTPStorages/" + this.id + ".binarycookies", "Saved Application State/" + this.id + ".savedState"])
        fs.rmSync(path.join(lib, d), { recursive: true, force: true });
    }
  }
}

// ---- targets: @id is a card or Section on the board as each side has it now, at the middle of its top strip;
// @id+dx,dy is that many board units from its top-left corner. The web board says where its element is; the Mac app's
// place comes from its vault's board file and its camera.
/** The storage folder's cards by id (its board files) */
function boardCards() {
  const out = {};
  for (const f of fs.readdirSync(storage).filter((f) => f.endsWith(".json")))
    for (const c of JSON.parse(fs.readFileSync(path.join(storage, f), "utf8")).cards ?? []) out[c.id] = c;
  return out;
}
/** Where the storage folder's boards put their cards (x, y, w) */
function boardPlace() {
  const out = {};
  for (const f of fs.readdirSync(storage).filter((f) => f.endsWith(".json")))
    Object.assign(out, JSON.parse(fs.readFileSync(path.join(storage, f), "utf8")).place ?? {});
  return out;
}
/** A card in the demo: its box in the window (content coordinates, top left origin) and the zoom, from its report */
function demoCard(d, id) {
  const r = JSON.parse(fs.readFileSync(d.place, "utf8"));
  const i = Math.max(0, d.cards.indexOf(id));
  const [x, y, w, h] = r.cards?.[i]?.card ?? r.card;
  return { box: [x, y, x + w, y + h], zoom: r.zoom };
}
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
// @id"words" (the middle of those words in that card), @id"words"< (just before them), @id"words"> (just after): found
// on screen as a person reads them (the web side in the rendered page, the Mac side by text recognition on the window),
// so a scenario aims at text, whatever each side's layout. A trailing +dx,dy moves that many points from there (a grip
// beside a table row, the line under a heading)
const TOKEN = /@[\w-]+"[^"]*"[<>]?(?:\+-?[\d.]+,-?[\d.]+)?|\S+/g;
async function point(d, tok, onBoard = false) {
  // @view:Class (the Mac side): the middle of the first view of that class, @view:Class< its left end, @view:Class> its
  // right end, then +dx,dy points (a control the app draws in a view of its own, such as the selection toolbar's buttons)
  const v = /^@view:([\w.]+)([<>]?)(?:\+(-?[\d.]+),(-?[\d.]+))?$/.exec(tok);
  if (v) {
    if (d.side !== "mac") throw new Error(`${tok}: a view is a Mac target`);
    const r = await d.send(`frame ${v[1]} content`);
    if (!/^[-\d.]+ [-\d.]+ [\d.]+ [\d.]+$/.test(r)) throw new Error(`mac: no view ${v[1]}`);
    const [x, y, w, h] = r.split(" ").map(Number);
    const px = v[2] === "<" ? x : v[2] === ">" ? x + w : x + w / 2;
    return `${(px + Number(v[3] ?? 0)).toFixed(1)} ${(y + h / 2 + Number(v[4] ?? 0)).toFixed(1)}`;
  }
  // @id"words": see TOKEN
  const t = /^@([\w-]+)"([^"]*)"([<>]?)(?:\+(-?[\d.]+),(-?[\d.]+))?$/.exec(tok);
  if (t) {
    const mode = t[3] === "<" ? "before" : t[3] === ">" ? "after" : "mid";
    let r;
    if (d.side === "web") r = await d.send(`find ${t[1]} ${mode} ${t[2]}`);
    else if (demo) r = await d.send(`find ${demoCard(d, t[1]).box.map((v) => v.toFixed(1)).join(" ")} ${mode} ${t[2]}`);
    else {
      const g = await geom(d, t[1], false, true);
      if (typeof g !== "object") throw new Error(`mac: no card ${t[1]}`);
      const [x0, y0] = (await d.send(`where ${g.x} ${g.y}`)).split(" ").map(Number);
      const [x1, y1] = (await d.send(`where ${g.x + g.w} ${g.y + (g.h ?? 1e5)}`)).split(" ").map(Number);
      r = await d.send(`find ${x0.toFixed(1)} ${y0.toFixed(1)} ${x1.toFixed(1)} ${Math.min(y1, 5000).toFixed(1)} ${mode} ${t[2]}`);
    }
    if (!/^-?[\d.]+ -?[\d.]+$/.test(r)) throw new Error(`${d.side}: "${t[2]}" in ${t[1]}: ${r}`);
    const [x, y] = r.split(" ").map(Number);
    return `${(x + Number(t[4] ?? 0)).toFixed(1)} ${(y + Number(t[5] ?? 0)).toFixed(1)}`;
  }
  if (demo && d.side === "mac" && /^@[\w-]+(\+|$)/.test(tok)) {
    const m = /^@([\w-]+)(?:\+(-?[\d.]+),(-?[\d.]+))?$/.exec(tok);
    const { box, zoom } = demoCard(d, m[1]);
    const [dx, dy] = m[2] === undefined ? [(box[2] - box[0]) / zoom / 2, 14] : [Number(m[2]), Number(m[3])];
    return `${(box[0] + dx * zoom).toFixed(1)} ${(box[1] + dy * zoom).toFixed(1)}`;
  }
  // @row:<title>: the Mac app's sidebar row of that board
  if (tok.startsWith("@row:")) {
    // (the sidebar lists the vault a moment after the app starts and after each change: wait a little for the row)
    let r = await d.send(`row ${tok.slice(5)}`);
    for (let i = 0; r === "none" && i < 20; i++) { await sleep(100); r = await d.send(`row ${tok.slice(5)}`); }
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
  // what is typed is text, not targets
  if (/^(type|keys|ime) /.test(line)) return line;
  const out = [];
  // (a target a command presses or moves to must be on the board; plain x y can be anywhere in the window)
  for (const tok of line.match(TOKEN) ?? []) out.push(tok.startsWith("@") ? await point(d, tok, true) : tok);
  return out.join(" ");
}
async function cam(d) {
  const r = await d.send("cam");
  if (!/^-?[\d.]/.test(r)) throw new Error(`${d.side}: ${r} (is a board open?)`);
  return r.split(" ").map(Number);
}
/** source @id: a Note's Markdown as each side saved it (the Mac app in its vault, the web board in its last patch) */
async function source(d, id) {
  if (d.side === "web") return d.send(`source ${id}`);
  // the demo writes its file after every change (the second card's beside it, .2.md); nothing written yet is the
  // Markdown it opened
  if (demo) {
    const saved = d.cards.indexOf(id) === 1 ? d.saved.replace(/\.md$/, ".2.md") : d.saved;
    return fs.readFileSync(fs.existsSync(saved) ? saved : path.join(d.copy, `${id}.md`), "utf8");
  }
  const c = (await macSaved(d))[id];
  if (!c) return "none";
  const content = c.shared
    ? JSON.parse(fs.readFileSync(path.join(d.vault, ".codeboard/shared", `${id}.json`), "utf8")).content
    : c.content;
  return content?.note?.text ?? content?.text?.text ?? "none";
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

const storageBoard = () =>
  JSON.parse(fs.readFileSync(path.join(storage, fs.readdirSync(storage).find((f) => f.endsWith(".json"))), "utf8"));

// ---- expectations: `expect <subject> <op> <value>`, checked on each side as the scenario runs
//   subjects: <id>.x|y|w|h|right|bottom|section (board units; a card or Section), cam.x|y|zoom, pointer.x|y (board
//   units), ui.<part>.x|y|w|h|right|bottom (the toolbar, the dock and their parts, in points from the board's top
//   left), press (what the last
//   press landed on), focus (where keys go now), hover (the card whose ports show), answer (ms from the last input reaching the app to the first change on screen, the drawn
//   pointer left out; needs a running `rec`)
//   ops: = != < <= > >= ~ (within 2) has lacks; values: a number, a word, another subject (`<id>.bottom`), was, was+N,
//   was-N (the subject at `mark`)
// The Mac app's cards, Sections, arrow labels, sidenote markers and stickers are where its canvas's accessibility elements
// say (identifier = id); with none (a card or Section asked for its Section, or not drawn), cards and Sections are read
// from its saved board file, so while a button is held they are not checkable there.
/** A card's, Section's, arrow label's, sidenote marker's or sticker's place in board units as this side has it now:
 *  x y w h right bottom (and section on the Mac); undefined while a button is held on the Mac without accessibility
 *  elements, "missing" when there is no such item */
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
// what sel reads in a page (one line: it goes through the drivers' FIFOs)
const SEL = `(() => {
  const a = document.activeElement, pm = a && a.closest && a.closest(".ProseMirror"), ed = pm && pm.editor;
  if (ed) { const { from, to } = ed.state.selection; return JSON.stringify([ed.state.doc.textBetween(from, to, "\\n"), from + "-" + to]); }
  if (a && typeof a.selectionStart === "number") return JSON.stringify([a.value.slice(a.selectionStart, a.selectionEnd), a.selectionStart + "-" + a.selectionEnd]);
  const s = getSelection();
  const editable = a && a.isContentEditable;
  if (!s || !s.rangeCount || (s.isCollapsed && !editable)) return "none";
  const r = s.getRangeAt(0), pre = document.createRange(), root = editable ? a : document.body;
  pre.setStart(root, 0); pre.setEnd(r.startContainer, r.startOffset);
  const from = pre.toString().length;
  return JSON.stringify([s.toString(), from + "-" + (from + r.toString().length)]);
})()`.replaceAll("\n", " ");
async function subject(d, subj) {
  const [id, field] = subj.split(".");
  // focus: what keys go to now (the Mac's first responder, e.g. OnBoardField's NSTextView; the page's focused element)
  // dialog: the dialog that is up (its text and buttons; none)
  if (subj === "dialog") return (await d.send("dialog")) || "none";
  // row:<title>: whether the sidebar shows that board's or folder's row (shown, none)
  if (subj.startsWith("row:")) return (await d.send(`row ${subj.slice(4)}`)) === "none" ? "none" : "shown";
  // sel, sel.text, sel.range: the selected text where keys go and its range (from-to; a caret: n-n; none): in a
  // ProseMirror editor (a Note, on both sides the same editor) its positions, in a field its offsets, elsewhere the
  // page selection's text offsets in the focused editable; in the Mac app's native text views their own offsets
  if (id === "sel") {
    const r = d.side === "web" ? await d.send(`eval ${SEL}`) : await d.send(`sel ${SEL}`);
    if (!r.startsWith("[")) return "none";
    const [text, range] = JSON.parse(r.replaceAll("\n", "\\n")); // JSON has no line breaks: send made them of its \\n
    return field === "text" ? text : field === "range" ? range : `${JSON.stringify(text)} ${range}`;
  }
  // opened: what the app asked to open outside itself so far, one per line (none); the drivers open nothing
  if (subj === "opened") return d.send("opened");
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
  // clip: what is on the run's own clipboard, one type a line (text/plain: its text, image/png 240x150; none)
  if (subj === "clip") return d.send("clipread");
  // tip: the tooltip shown now (its text, a shortcut after it; none)
  if (subj === "tip") return d.send("tip");
  // <arrow>.x1|y1|x2|y2: where an arrow starts and ends as drawn now (board units; re-routed while its cards move)
  if (["x1", "y1", "x2", "y2"].includes(field)) {
    const r = await d.send(`ends ${await idOf(d, id)}`);
    if (r === "none") return "missing";
    let [x1, y1, x2, y2] = r.split(" ").map(Number);
    if (d.side === "web") {
      const [ox, oy] = (await d.send("where 0 0")).split(" ").map(Number);
      const [, , z] = await cam(d);
      [x1, y1, x2, y2] = [(x1 - ox) / z, (y1 - oy) / z, (x2 - ox) / z, (y2 - oy) / z];
    }
    return { x1, y1, x2, y2 }[field];
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
const shown = (v) => (typeof v === "number" ? String(Math.round(v * 10) / 10) : String(v).replaceAll("\n", " | "));

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
  const [, , z] = await cam(d);
  // no size: the thing itself with a margin around it, the same on both sides: a card, Section, label, marker or sticker
  // (@id: 16 board units around it) or a part of the chrome (@ui.<part>: 8 points around it)
  if (w === undefined) {
    const u = /^@ui\.(\w+)$/.exec(target), id = /^@([\w-]+)$/.exec(target)?.[1];
    if (u) {
      const r = await d.send(`ui ${u[1]}`);
      if (!/^-?[\d.]+ /.test(r)) throw new Error(`${d.side}: no ${u[1]} in the chrome (${r})`);
      const [, , uw, uh] = r.split(" ").map(Number);
      [target, w, h] = [`${target}:tl`, (uw + 16) / z, (uh + 16) / z];
      const [tx, ty] = (await point(d, target)).split(" ").map(Number);
      target = `${tx - 8} ${ty - 8}`;
    } else if (id) {
      const g = await geom(d, id, false, true);
      if (typeof g !== "object" || g.h === undefined) throw new Error(`${d.side}: ${id} has no known size to cut (give W H)`);
      [target, w, h] = [`@${id}+-16,-16`, g.w + 32, g.h + 32];
    } else throw new Error(`shot: a size W H is needed with ${target}`);
  }
  const [x, y] = (/^-?[\d.]+ -?[\d.]+$/.test(target) ? target : await point(d, target)).split(" ").map(Number);
  const [ox, oy] = (await d.send("origin")).split(" ").map(Number);
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
// an ffmpeg built without freetype (Homebrew's) has no drawtext: the sides go unlabelled (Mac is always on the left)
let drawtext;
function sideBySide(out, name, have, dirs) {
  drawtext ??= / drawtext /.test(execFileSync("ffmpeg", ["-hide_banner", "-filters"]).toString());
  const font = "/System/Library/Fonts/Helvetica.ttc";
  const text = (side) =>
    drawtext ? `,drawtext=fontfile=${font}:text=${side === "mac" ? "Mac" : "VS Code"}:x=12:y=h-36:fontsize=24:fontcolor=red` : "";
  const label = (i, side) => `[${i}]scale=-2:720,fps=30${text(side)},tpad=stop_mode=clone:stop_duration=3[v${i}]`;
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
 *  answer (first frame that changed after the command ended; a key's from when it started; a click's from its first
 *  press, against the window just before it) and to settle (no change for 300 ms) */
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
    if (/^(click|dbl|up|key|keys|type|ime|drag|menu)\b/.test(done[2])) {
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

// ---- idle: CPU and memory of a side over a few seconds at rest (recorded, never a failure). The Mac side is its one
// process (the app and the driver: the driver sleeps meanwhile); the web side is the whole Chromium tree its driver
// started (not the node driver). CPU from the processes' CPU time; memory as footprint (phys_footprint, what Activity
// Monitor shows as Memory, JavaScriptCore's heaps included) and resident size
function tree(root) {
  const rows = execFileSync("ps", ["-axo", "pid=,ppid="]).toString().trim().split("\n").map((l) => l.trim().split(/\s+/).map(Number));
  const kids = (p) => rows.filter((r) => r[1] === p).map((r) => r[0]);
  const out = [];
  const walk = (p) => kids(p).forEach((k) => (out.push(k), walk(k)));
  walk(root);
  return out;
}
function cpuSeconds(pids) {
  if (!pids.length) return 0;
  const t = execFileSync("ps", ["-o", "cputime=", "-p", pids.join(",")]).toString().trim().split("\n");
  return t.reduce((s, x) => {
    const [a, b, c] = x.trim().split(":").map(Number);
    return s + (c === undefined ? a * 60 + b : a * 3600 + b * 60 + c);
  }, 0);
}
function memory(pids) {
  if (!pids.length) return { footprint: 0, rss: 0 };
  const rss = execFileSync("ps", ["-o", "rss=", "-p", pids.join(",")]).toString().trim().split("\n").reduce((s, x) => s + Number(x), 0) / 1024;
  let footprint = 0;
  try {
    const t = execFileSync("footprint", pids.flatMap((p) => ["-p", String(p)]), { stdio: ["ignore", "pipe", "ignore"] }).toString();
    const unit = { KB: 1 / 1024, MB: 1, GB: 1024 };
    for (const m of t.matchAll(/\[\d+\]: \S+\s+Footprint: ([\d.]+) (KB|MB|GB)/g)) footprint += Number(m[1]) * unit[m[2]];
  } catch {}
  return { footprint, rss };
}
async function idle(d, out, secs, label) {
  const pids = () => (d.side === "mac" ? [d.proc.pid] : tree(d.proc.pid).filter((p) => p !== d.proc.pid));
  const cpu = [];
  let last = cpuSeconds(pids());
  for (let i = 0; i < secs; i++) {
    await sleep(1000);
    const now = cpuSeconds(pids());
    cpu.push(((now - last) / 1) * 100);
    last = now;
  }
  const m = memory(pids());
  const line = `idle ${label}: CPU ${cpu.map((c) => c.toFixed(1)).join(" ")} % (mean ${(cpu.reduce((a, b) => a + b, 0) / cpu.length).toFixed(1)}), footprint ${m.footprint.toFixed(0)} MB, resident ${m.rss.toFixed(0)} MB${d.side === "web" ? ` (${pids().length} Chromium processes)` : ""}`;
  fs.appendFileSync(path.join(out, `results-${d.side}.txt`), `${line}\n\n`);
  fs.appendFileSync(path.join(out, "idle.txt"), `${d.side} ${line}\n`);
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
  // the cards the scenario is about (the first it names, a second): the ones the demo opens
  const named = [...fs.readFileSync(file, "utf8").replace(/^#.*$/gm, "").matchAll(/@(?!view:|row:|ui\.)([\w-]+)/g)].map((m) => m[1]);
  // a line "screen on": the Mac side runs on screen as it opens (real-use), not hidden at the driver's size; off unless
  // a scenario asks, since it puts a window in front of the person using the Mac
  const onScreen = /^screen on$/m.test(fs.readFileSync(file, "utf8"));
  const checks = [];
  for (const d of drivers) {
    d.onScreen = onScreen;
    d.cards = [...new Set(named)].slice(0, 2);
    d.card = d.cards[0];
  }
  const recs = new Set(), shots = new Set();
  let lines = fs.readFileSync(file, "utf8").split("\n").map((l, i) => ({ n: i + 1, text: l.trim() }));
  if (ci) {
    // nothing timed; a shot before the first step, one halfway and one after the last
    // (the comments stay: `# known` is read from them)
    const kept = lines.filter((l) => l.text && !/^(\w+:\s*)?(rec|stop)\b/.test(l.text));
    const steps = kept.filter((l) => !l.text.startsWith("#"));
    const shot = (k, n) => ({ n, text: `shot ci-${k}` });
    const mid = steps[Math.floor(steps.length / 2)];
    lines = [shot("1-start", 0), ...kept.flatMap((l) => (l === mid ? [shot("2-middle", l.n), l] : [l])), shot("3-end", lines.length)];
  }
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
      const keep = ({ side, dir, pid, vault, copy, env, id }) => ({ side, dir, pid, vault, copy, env, id });
      fs.writeFileSync(sessionFile, JSON.stringify(drivers.map(keep)));
    }
    for (const { n, text: line } of lines) {
      if (!line || line.startsWith("#")) continue;
      // mac: and web: send a line to one side; demo: and app: to the Mac side when it is the demo or the app (where
      // their layouts differ: a native table's row grips, a native picture's size)
      const m = /^(mac|web|demo|app):\s*(.*)$/.exec(line);
      if (m && ((m[1] === "demo" && !demo) || (m[1] === "app" && demo))) continue;
      const to = m && (m[1] === "demo" || m[1] === "app") ? "mac" : m?.[1];
      const cmd = m ? m[2] : line;
      // what an expect wants is the rest of the line (a selected text has spaces)
      const [verb, arg, op, ...rest] = cmd.split(" "), want = rest.join(" ");
      if (verb === "rec") recs.add(arg);
      if (verb === "shot") shots.add(arg);
      const sources = {};
      // shot <name> @target W H: also the board rectangle W × H (board units) from the target, cut out on each side,
      // so the two sides' pictures of one part line up
      const crop = verb === "shot" && cmd.split(" ")[2]?.startsWith("@") ? cmd.split(" ").slice(2) : undefined;
      // a side whose driver exited (the app crashed) failed once, with why; its later lines are not run
      const sent = drivers.filter((d) => (!to || to === d.side) && !d.gone);
      // a line that cannot run (no such card, a height not known) fails as an expectation would, and the run goes on
      await Promise.all(
        sent
          .map((d) => (async () => {
            if (verb === "reopen") return d.reopen();
            if (verb === "screen") return;
            // report: the Markdown demo's own report at this moment (card and editor frames, zoom) into the results
            if (verb === "report") {
              if (demo && d.side === "mac") fs.appendFileSync(path.join(out, "results-mac.txt"), `report\n${fs.readFileSync(d.place, "utf8")}\n\n`);
              return;
            }
            if (verb === "idle") return idle(d, out, Number(arg), cmd.split(" ")[2] ?? "idle");
            if (verb === "covered") {
              if (!(demo && d.side === "mac")) return;
              const e = JSON.parse(fs.readFileSync(d.place, "utf8")).editor;
              const r = await d.send(`covered ${e.map((v) => v.toFixed(1)).join(" ")}`);
              checks.push(`${r.startsWith("COVERED") ? "FAIL" : "pass"} ${d.side} editor ${cmd.split(" ")[1] ?? ""}: ${r}`);
              fs.appendFileSync(path.join(out, `results-${d.side}.txt`), `${cmd}\n${r}\n\n`);
              return;
            }
            if (verb === "source") {
              const md = await source(d, arg.slice(1));
              sources[d.side] = md;
              fs.appendFileSync(path.join(out, `results-${d.side}.txt`), `${cmd}\n${md}\n\n`);
              return;
            }
            // the demo has one card, centred, at 100 % (its own zoom is a toolbar control, not a pinch)
            if (demo && d.side === "mac" && (verb === "zoom" || verb === "center")) return;
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
              if (arg === "answer" && ci) return results[d.side].push({ n, cmd, ok: undefined, got: "not timed in CI" });
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
            // clip image <file> / drop <file> <point>: the file from the tools folder (storage/assets/…) or absolute
            const file = (f) => path.resolve(here, f);
            if (verb === "clip" && arg === "image") return void (await d.send(`clip image ${file(cmd.split(" ").slice(2).join(" "))}`));
            if (verb === "drop") {
              const r = await d.send(`drop ${file(arg)} ${await resolve(d, cmd.split(" ").slice(2).join(" "))}`);
              return fs.appendFileSync(path.join(out, `results-${d.side}.txt`), `${cmd}\n${r}\n\n`);
            }
            const r = await d.send(await resolve(d, cmd));
            if (r) fs.appendFileSync(path.join(out, `results-${d.side}.txt`), `${cmd}\n${r}\n\n`);
          })().catch((e) => {
            if (/driver exited/.test(e.message)) d.gone = true;
            results[d.side].push({ n, cmd, ok: false, got: d.gone ? `${e.message}; the lines after it were not run` : e.message });
          })),
      );
      if (verb === "source" && sides.length > 1)
        fs.appendFileSync(
          path.join(out, "sources.txt"),
          `${cmd}: ${sources.mac === sources.web ? "same" : `DIFFERENT\n--- mac\n${sources.mac}\n--- web\n${sources.web}`}\n`,
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
  // a window a person would see as blank or broken: a shot with (almost) nothing in it
  for (const s of shots)
    for (const side of sides) {
      const f = path.join(out, side, `${s}.png`);
      if (!fs.existsSync(f)) continue;
      const st = await sharp(f).stats();
      const spread = Math.max(...st.channels.slice(0, 3).map((c) => c.stdev));
      checks.push(`${spread < 3 ? "FAIL" : "pass"} ${side} shot ${s}: ${spread < 3 ? "blank" : "drawn"} (spread ${spread.toFixed(1)})`);
    }
  if (checks.length) {
    fs.writeFileSync(path.join(out, "checks.txt"), `${checks.join("\n")}\n`);
    for (const c of checks.filter((c) => c.startsWith("FAIL"))) console.warn(`${name}: ${c}`);
  }
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
