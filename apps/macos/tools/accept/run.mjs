#!/usr/bin/env node
// The acceptance runner (README.md): runs scenario files on the Mac app and on the web board VS Code shows, side by side,
// with a hand's pointer, and writes recordings, screenshots and a report to apps/macos/.build-accept/<scenario>/.
//   node apps/macos/tools/accept/run.mjs <scenario.txt>… [--only mac|web] [--storage <folder>] [--web <checkout>] [--skip-build]
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
const storage = path.resolve(opt("--storage") ?? path.join(mac, "tools/look/storage"));
const scenarios = argv.filter((a, i) => !a.startsWith("--") && !["--only", "--storage", "--web"].includes(argv[i - 1]));
// --web <checkout>: the web side draws that checkout's board (a worktree of the latest main: the VS Code version to beat)
const webRepo = path.resolve(opt("--web") ?? repo);
const sides = only ? [only] : ["mac", "web"];
const run = (cmd, a, cwd = repo) => execFileSync(cmd, a, { cwd, stdio: "inherit" });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
if (!scenarios.length) throw new Error("usage: run.mjs <scenario.txt>… [--only mac|web] [--storage <folder>] [--web <checkout>] [--skip-build]");

// ---- build: the driver app (its own name and bundle id, never the app in use) and the web side
fs.mkdirSync(outRoot, { recursive: true });
const app = path.join(outRoot, "CodeBoard Accept.app");
const webBundle = path.join(outRoot, "web.mjs");
// --skip-build skips the web builds (the board, the Note page); the driver is always built (swift build is incremental)
const skip = argv.includes("--skip-build");
if (!skip && sides.includes("web")) {
  run("npm", ["run", "build", "-w", "@yhnocoder/markdown"], webRepo);
  run("npm", ["run", "build", "-w", "@codeboard/board"], webRepo);
}
if (sides.includes("mac")) {
  if (!skip) run("node", ["apps/macos/web/build.mjs"]);
  run("swift", ["build", "-c", "release", "--product", "Accept"], mac);
  const bin = execFileSync("swift", ["build", "-c", "release", "--show-bin-path"], { cwd: mac }).toString().trim();
  fs.rmSync(app, { recursive: true, force: true });
  fs.mkdirSync(path.join(app, "Contents/MacOS"), { recursive: true });
  fs.copyFileSync(path.join(bin, "Accept"), path.join(app, "Contents/MacOS/Accept"));
  fs.cpSync(path.join(mac, "web/dist"), path.join(app, "Contents/Resources/NotePage"), { recursive: true });
}
if (sides.includes("web")) {
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
    const env = { ...process.env, ACCEPT_OUT: this.dir, ACCEPT_FIFO: path.join(this.dir, "cmd"), ACCEPT_REPO: repo, ACCEPT_WEB: webRepo };
    const outFd = fs.openSync(path.join(this.dir, "stdout.txt"), "w");
    if (this.side === "mac") {
      // a vault of its own, imported from the storage folder; the app's own defaults start empty
      this.vault = fs.mkdtempSync(path.join(os.tmpdir(), "accept-vault-"));
      this.plist(this.vault);
      execFileSync("sh", ["-c", "defaults delete com.example.codeboard.accept >/dev/null 2>&1 || true"]);
      Object.assign(env, { ACCEPT_VAULT: this.vault, ACCEPT_IMPORT_FROM: storage });
      this.proc = spawn(path.join(app, "Contents/MacOS/Accept"), [], { env, stdio: ["ignore", outFd, outFd] });
    } else {
      this.copy = fs.mkdtempSync(path.join(os.tmpdir(), "accept-storage-"));
      fs.cpSync(storage, this.copy, { recursive: true });
      this.proc = spawn("node", [webBundle, this.copy, this.dir], { env, cwd: repo, stdio: ["ignore", outFd, outFd] });
    }
    await this.until(/driver ready|web ready/, 60000);
    // the Mac app starts on its sidebar: open the first board, as a person would
    if (this.side === "mac") for (const c of ["warp 700 500", "click 90 91", "wait 1500", "focus", "move 700 650 200"]) await this.send(c);
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
  lines() {
    return fs.existsSync(this.log) ? fs.readFileSync(this.log, "utf8").split("\n") : [];
  }
  async until(re, ms) {
    for (let t = 0; t < ms; t += 50) {
      if (this.proc.exitCode !== null) throw new Error(`${this.side} driver exited: see ${this.dir}/stdout.txt`);
      if (this.lines().some((l) => re.test(l))) return;
      await sleep(50);
    }
    throw new Error(`${this.side}: timed out waiting for ${re}`);
  }
  async send(line) {
    const n = ++this.n;
    fs.writeFileSync(path.join(this.dir, "cmd"), `${line}\n`);
    const re = new RegExp(`^\\S+ done ${n} `);
    for (let t = 0; t < 120000; t += 20) {
      const l = this.lines().find((x) => re.test(x));
      if (l) return l.includes(" -> ") ? l.slice(l.indexOf(" -> ") + 4).replace(/\\(\\|n)/g, (_, c) => (c === "n" ? "\n" : "\\")) : "";
      if (this.proc.exitCode !== null) throw new Error(`${this.side} driver exited: see ${this.dir}/stdout.txt`);
      await sleep(20);
    }
    throw new Error(`${this.side}: no answer to ${line}`);
  }
  async stop() {
    await Promise.race([this.send("quit").catch(() => {}), sleep(1500)]);
    this.proc.kill("SIGTERM");
    await sleep(300);
    if (this.proc.exitCode === null) this.proc.kill("SIGKILL");
    for (const d of [this.vault, this.copy]) if (d) fs.rmSync(d, { recursive: true, force: true });
  }
}

// ---- targets: @id is a card or Section on the board as each side has it now, at the middle of its top strip;
// @id+dx,dy is that many board units from its top-left corner. The web board says where its element is; the Mac app's
// place comes from its vault's board file and its camera.
function macBoardFile(d) {
  const f = fs.readdirSync(d.vault, { recursive: true }).find((f) => String(f).endsWith("board.json"));
  return path.join(d.vault, String(f));
}
function macBoard(d) {
  const b = JSON.parse(fs.readFileSync(macBoardFile(d), "utf8"));
  return Object.fromEntries([...(b.sections ?? []), ...(b.cards ?? [])].map((c) => [c.id, c]));
}
/** A card's or Section's box in the Mac window (content coordinates), from the vault and the camera; a card without a
 *  stored height reaches to the window's bottom */
async function macBox(d, c) {
  const [x0, y0] = (await d.send(`where ${c.x} ${c.y}`)).split(" ").map(Number);
  const [x1, y1] = (await d.send(`where ${c.x + c.width} ${c.y + (c.height ?? c.measuredHeight ?? 1e5)}`)).split(" ").map(Number);
  return [x0, y0, x1, Math.min(y1, 5000)];
}
// @id"words" (the middle of those words in that card), @id"words"< (just before them), @id"words"> (just after): found
// on screen as a person reads them (the web side in the rendered page, the Mac side by text recognition on the window),
// so a scenario aims at text, whatever each side's layout. A trailing +dx,dy moves that many points from there (a grip
// beside a table row, the line under a heading)
const TOKEN = /@[\w-]+"[^"]*"[<>]?(?:\+-?[\d.]+,-?[\d.]+)?|\S+/g;
async function point(d, tok) {
  const t = /^@([\w-]+)"([^"]*)"([<>]?)(?:\+(-?[\d.]+),(-?[\d.]+))?$/.exec(tok);
  if (t) {
    const mode = t[3] === "<" ? "before" : t[3] === ">" ? "after" : "mid";
    let r;
    if (d.side === "web") r = await d.send(`find ${t[1]} ${mode} ${t[2]}`);
    else {
      const c = macBoard(d)[t[1]];
      if (!c) throw new Error(`mac: no card ${t[1]}`);
      r = await d.send(`find ${(await macBox(d, c)).map((v) => v.toFixed(1)).join(" ")} ${mode} ${t[2]}`);
    }
    if (!/^-?[\d.]+ -?[\d.]+$/.test(r)) throw new Error(`${d.side}: "${t[2]}" in ${t[1]}: ${r}`);
    const [x, y] = r.split(" ").map(Number);
    return `${(x + Number(t[4] ?? 0)).toFixed(1)} ${(y + Number(t[5] ?? 0)).toFixed(1)}`;
  }
  const m = /^@([\w-]+)(?:\+(-?[\d.]+),(-?[\d.]+))?$/.exec(tok);
  if (!m) throw new Error(`not a target: ${tok}`);
  if (d.side === "web") {
    const r = await d.send(`rect ${m[1]}`);
    if (r === "none") throw new Error(`web: no card or Section ${m[1]}`);
    const [left, top, w] = r.split(" ").map(Number);
    const [, , z] = await cam(d);
    const [dx, dy] = m[2] === undefined ? [w / z / 2, 14] : [Number(m[2]), Number(m[3])];
    return `${(left + dx * z).toFixed(1)} ${(top + dy * z).toFixed(1)}`;
  }
  const c = macBoard(d)[m[1]];
  if (!c) throw new Error(`mac: no card or Section ${m[1]}`);
  const [dx, dy] = m[2] === undefined ? [c.width / 2, 14] : [Number(m[2]), Number(m[3])];
  return d.send(`where ${c.x + dx} ${c.y + dy}`);
}
async function resolve(d, line) {
  // what is typed is text, not targets
  if (/^(type|keys|ime) /.test(line)) return line;
  const out = [];
  for (const tok of line.match(TOKEN) ?? []) out.push(tok.startsWith("@") ? await point(d, tok) : tok);
  return out.join(" ");
}
/** source @id: a Note's Markdown as each side saved it (the Mac app in its vault, the web board in its last patch) */
async function source(d, id) {
  if (d.side === "web") return d.send(`source ${id}`);
  const c = macBoard(d)[id];
  if (!c) return "none";
  const content = c.shared
    ? JSON.parse(fs.readFileSync(path.join(d.vault, ".codeboard/shared", `${id}.json`), "utf8")).content
    : c.content;
  return content?.note?.text ?? content?.text?.text ?? "none";
}
const cam = async (d) => (await d.send("cam")).split(" ").map(Number);
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

// ---- outputs
const fpsOf = (dir) => {
  const t = fs.readFileSync(path.join(dir, "times.txt"), "utf8").split("\n").filter(Boolean).map(Number);
  return t.length > 1 ? (t.length - 1) / (t[t.length - 1] - t[0]) : 30;
};
function sideBySide(out, name, have) {
  const font = "/System/Library/Fonts/Helvetica.ttc";
  const label = (i, side) =>
    `[${i}]scale=-2:720,fps=30,drawtext=fontfile=${font}:text=${side === "mac" ? "Mac" : "VS Code"}:x=12:y=h-36:fontsize=24:fontcolor=red,tpad=stop_mode=clone:stop_duration=3[v${i}]`;
  const ins = have.flatMap((s) => ["-framerate", fpsOf(path.join(out, s, name)).toFixed(2), "-i", path.join(out, s, name, "f%05d.png")]);
  const f = have.map((s, i) => label(i, s)).join(";");
  const stack = have.length > 1 ? `;[v0][v1]hstack=2:shortest=1,pad=ceil(iw/2)*2:ceil(ih/2)*2[o]` : ";[v0]pad=ceil(iw/2)*2:ceil(ih/2)*2[o]";
  execFileSync("ffmpeg", ["-loglevel", "error", "-y", ...ins, "-filter_complex", f + stack, "-map", "[o]", "-c:v", "libx264", "-pix_fmt", "yuv420p", path.join(out, `${name}.mp4`)]);
}
async function shotPair(out, name, have) {
  const files = have.map((s) => path.join(out, s, `${name}.png`)).filter((f) => fs.existsSync(f));
  if (files.length < 2) return;
  const imgs = await Promise.all(files.map((f) => sharp(f).resize({ height: 760 }).toBuffer({ resolveWithObject: true })));
  const width = imgs.reduce((a, i) => a + i.info.width, 0);
  let left = 0;
  await sharp({ create: { width, height: 760, channels: 3, background: "#000" } })
    .composite(imgs.map((i) => ({ input: i.data, left: (left += i.info.width) - i.info.width, top: 0 })))
    .png()
    .toFile(path.join(out, `${name}.png`));
}

/** Per side: each command's time, what each press landed on, and for recorded commands how long the window took to
 *  answer (first frame that changed after the command ended) and to settle (no change for 300 ms) */
async function report(d, out) {
  const rows = [];
  const lines = d.lines().filter(Boolean).map((l) => {
    const i = l.indexOf(" ");
    return { t: Number(l.slice(0, i)), text: l.slice(i + 1) };
  });
  const recs = fs.readdirSync(d.dir).filter((f) => fs.existsSync(path.join(d.dir, f, "times.txt")));
  const frames = [];
  for (const r of recs) {
    const times = fs.readFileSync(path.join(d.dir, r, "times.txt"), "utf8").split("\n").filter(Boolean).map(Number);
    times.forEach((t, i) => frames.push({ t, file: path.join(d.dir, r, `f${String(i).padStart(5, "0")}.png`) }));
  }
  const small = new Map();
  const pixels = async (f) => small.get(f) ?? small.set(f, await sharp(f).resize(160, 104, { fit: "fill" }).raw().toBuffer()).get(f);
  const differ = async (a, b) => {
    const [x, y] = await Promise.all([pixels(a), pixels(b)]);
    let n = 0;
    for (let i = 0; i < x.length; i++) if (Math.abs(x[i] - y[i]) > 24) n++;
    return n > 3;
  };
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
      const at = frames.findIndex((f) => f.t >= l.t);
      if (at > 0) {
        let first, last;
        // (Chromium sends a frame only when the picture changed; the Mac recorder sends every frame)
        for (let i = at; i < frames.length && frames[i].t - l.t < 3; i++) {
          if (last !== undefined && frames[i].t - last > 0.3) break;
          if (await differ(frames[i - 1].file, frames[i].file)) {
            first ??= frames[i].t;
            last = frames[i].t;
          }
        }
        answer = first === undefined ? "  no change within 3 s" : `  answered ${((first - l.t) * 1000).toFixed(0)} ms, settled ${((last - l.t) * 1000).toFixed(0)} ms`;
      }
    }
    rows.push(`${((l.t - (start?.t ?? l.t)) * 1000).toFixed(0).padStart(6)} ms  ${done[2]}${answer}`);
  }
  const counts = Object.entries(inputs).filter(([, n]) => n).map(([k, n]) => `${k} ${n}`).join(", ");
  fs.writeFileSync(path.join(out, `report-${d.side}.txt`), `inputs: ${counts}\n\n${rows.join("\n")}\n`);
}

// ---- scenarios
for (const file of scenarios) {
  const name = path.basename(file).replace(/\.\w+$/, "");
  const out = path.join(outRoot, name);
  fs.rmSync(out, { recursive: true, force: true });
  const drivers = sides.map((s) => new Driver(s, path.join(out, s)));
  const recs = new Set(), shots = new Set();
  try {
    await Promise.all(drivers.map((d) => d.start()));
    for (const raw of fs.readFileSync(file, "utf8").split("\n")) {
      const line = raw.trim();
      if (!line || line.startsWith("#")) continue;
      const m = /^(mac|web):\s*(.*)$/.exec(line);
      const cmd = m ? m[2] : line;
      const [verb, arg] = cmd.split(" ");
      if (verb === "rec") recs.add(arg);
      if (verb === "shot") shots.add(arg);
      const sources = {};
      await Promise.all(
        drivers
          .filter((d) => !m || m[1] === d.side)
          .map(async (d) => {
            if (verb === "zoom") return zoomTo(d, Number(arg));
            if (verb === "center") return centerOn(d, arg);
            if (verb === "source") {
              const md = await source(d, arg.slice(1));
              sources[d.side] = md;
              fs.appendFileSync(path.join(out, `results-${d.side}.txt`), `${cmd}\n${md}\n\n`);
              return;
            }
            const r = await d.send(await resolve(d, cmd));
            if (r) fs.appendFileSync(path.join(out, `results-${d.side}.txt`), `${cmd}\n${r}\n\n`);
          }),
      );
      if (verb === "source" && sides.length > 1)
        fs.appendFileSync(
          path.join(out, "sources.txt"),
          `${cmd}: ${sources.mac === sources.web ? "same" : `DIFFERENT\n--- mac\n${sources.mac}\n--- web\n${sources.web}`}\n`,
        );
    }
  } finally {
    await Promise.all(drivers.map((d) => d.stop()));
  }
  for (const r of recs) {
    const have = sides.filter((s) => fs.existsSync(path.join(out, s, r, "f00000.png")));
    for (const s of sides.filter((x) => !have.includes(x)))
      console.warn(`${name}: ${s} recorded no frames for ${r} (${path.join(out, s, "log.txt")} says why)`);
    if (have.length) sideBySide(out, r, have);
  }
  for (const s of shots) await shotPair(out, s, sides);
  for (const d of drivers) await report(d, out);
  console.log(`${name}: ${out}`);
}
