// The human-use pass of the macOS gate (`npm run mac:gate -- --human [--project ~/Projects/persona]`): the app from a plain launch
// into the library, used by clicks and keys at the controls' places (apps/macos/Sources/CodeBoard/Human.swift), in a sandbox: a
// copy of the project, a VS Code registry naming that copy, and CODEBOARD_HOME / BOX_HOME for the defaults, caches, cameras and
// box. Nothing real is read and written: the project itself is only copied. Two launches: the steps, ⌘Q, then a relaunch that
// checks what persisted. The recording (this app's windows only, H.264) and its marks are joined into one run.mp4 / marks.json /
// regions.json; tools/rec-check.mjs judges it when it is there. Prints step | pass | what a person sees | screenshot, exits 1 on
// any failure.
import { execFileSync, spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

/** The steps whose clips are kept even when they pass (Linda watches them); failing steps' clips are kept too */
const KEEP_CLIPS = ["open_board", "pan", "zoom", "add_note", "edit_note", "switch_board", "relaunch"];

export async function runHuman({ root, gateApp, out, opt, diskWhy, writeSizes }) {
  // a locked screen draws nothing a person would see: no frames land, nothing can be recorded or pictured, no app comes forward
  if (screenLocked()) {
    console.log(
      "the screen is locked: the human pass needs it unlocked (nothing is drawn, recorded or brought forward while locked)",
    );
    return false;
  }
  const src = path.resolve(opt("--project", path.join(os.homedir(), "Projects/persona")).replace(/^~/, os.homedir()));
  const name = path.basename(src);
  const home = path.join(out, "home");
  const project = path.join(out, "projects", name);
  const run = path.join(out, "run");
  fs.mkdirSync(path.dirname(project), { recursive: true });
  fs.mkdirSync(run, { recursive: true });
  // a copy (APFS clones: quick), the boards and the sources they point at, git included (versions read it)
  execFileSync("cp", ["-Rc", src, project]);
  const real = fs.realpathSync(project);
  // the extension's registry as VS Code keeps it (Projects.swift registered(): globalStorage/state.vscdb, ItemTable)
  const user = path.join(home, "Library/Application Support/Code/User");
  fs.mkdirSync(path.join(user, "globalStorage"), { recursive: true });
  const db = new DatabaseSync(path.join(user, "globalStorage/state.vscdb"));
  db.exec("CREATE TABLE ItemTable (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB)");
  const reg = {
    "codeboard.projects": { [real]: { dir: path.join(real, ".codeboard"), folders: [real], name, seen: Date.now() } },
  };
  db.prepare("INSERT INTO ItemTable VALUES (?, ?)").run("yhnocoder.codeboard-vscode", JSON.stringify(reg));
  db.close();
  fs.writeFileSync(path.join(user, "settings.json"), "{}\n");
  fs.mkdirSync(path.join(home, "Preferences"), { recursive: true });

  const env = { ...process.env, CODEBOARD_HOME: home, BOX_HOME: path.join(home, "box") };
  const exe = path.join(gateApp, "Contents/MacOS/cbgate");
  const launch = async (extra) => {
    const log = fs.openSync(path.join(run, `${extra.length ? "relaunch" : "first"}.log`), "w");
    const p = spawn(exe, ["--human", run, ...extra], { stdio: ["ignore", log, log], env });
    const code = await new Promise((resolve) => {
      const t = setTimeout(() => {
        p.kill("SIGKILL");
        resolve("timeout");
      }, 300_000);
      p.on("exit", (c) => {
        clearTimeout(t);
        resolve(c);
      });
    });
    fs.closeSync(log);
    return code;
  };
  console.log(`human pass on a copy of ${src}`);
  // the disk guard (mac-gate.mjs): the recordings and clips count, the sandbox (home/, projects/) does not
  const stops = [];
  const guard = () => {
    const why = diskWhy();
    if (why) {
      writeSizes(why);
      stops.push({ step: "disk", pass: false, sees: `stopped: ${why} (see sizes.txt)`, shot: "" });
    }
    return !why;
  };
  const c1 = await launch([]);
  const c2 = guard() ? await launch(["--relaunch"]) : 0;
  // box serve, started for the sandbox, goes when idle; it is ours, so it goes now
  try {
    execFileSync("pkill", ["-f", `${env.BOX_HOME}`]);
  } catch {}

  const read = (f, d) =>
    fs.existsSync(path.join(run, f)) ? JSON.parse(fs.readFileSync(path.join(run, f), "utf8")) : d;
  const steps = [...read("first.json", []), ...read("relaunch.json", []), ...stops];
  if (c1 !== 0)
    steps.push({ step: "first launch", pass: false, sees: `the app exited with ${c1} (see run/first.log)`, shot: "" });
  if (c2 !== 0)
    steps.push({ step: "relaunch", pass: false, sees: `the app exited with ${c2} (see run/relaunch.log)`, shot: "" });

  // one video: the two launches back to back, the second's marks shifted by the first's length
  const parts = ["first", "relaunch"].filter((p) => fs.existsSync(path.join(run, `${p}.mp4`)));
  const video = path.join(out, "run.mp4");
  const marks = [];
  const regions = {};
  let offset = 0;
  for (const p of parts) {
    for (const m of read(`${p}-marks.json`, []))
      marks.push({
        name: m.name,
        start: +(m.start + offset).toFixed(3),
        end: +(m.end + offset).toFixed(3),
        // true: the camera moves all through the step; else the spans it moved in (a scroll to a card)
        moving: Array.isArray(m.camera)
          ? m.camera.map(([a, b]) => [+(a + offset).toFixed(3), +(b + offset).toFixed(3)])
          : m.camera,
      });
    Object.assign(regions, read(`${p}-regions.json`, {}));
    offset += duration(path.join(run, `${p}.mp4`));
  }
  if (parts.length) {
    const list = path.join(run, "parts.txt");
    fs.writeFileSync(list, parts.map((p) => `file '${path.join(run, `${p}.mp4`)}'`).join("\n"));
    execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "concat", "-safe", "0", "-i", list, "-c", "copy", video]);
    for (const p of parts) fs.rmSync(path.join(run, `${p}.mp4`));
    fs.rmSync(list);
  }
  fs.writeFileSync(path.join(out, "marks.json"), JSON.stringify(marks, null, 1));
  // rec-check's regions: each card's box on screen at the end of a step, for that step
  const boxes = Object.entries(regions).flatMap(([step, rs]) =>
    rs.map((r) => ({
      name: `${r.kind}:${r.id}`,
      step,
      x: Math.round(r.x),
      y: Math.round(r.y),
      w: Math.round(r.w),
      h: Math.round(r.h),
    })),
  );
  fs.writeFileSync(path.join(out, "regions.json"), JSON.stringify(boxes));

  // the recording judged frame by frame (blank, low-res, flash), by tools/rec-check.mjs when this branch has it
  const checker = path.join(root, "tools/rec-check.mjs");
  let rec = null;
  if (fs.existsSync(video) && fs.existsSync(checker)) {
    const r = spawnSyncNode(checker, [
      video,
      "--marks",
      path.join(out, "marks.json"),
      "--regions",
      path.join(out, "regions.json"),
      "--out",
      path.join(out, "rec-check"),
    ]);
    rec = { code: r.status, out: r.stdout };
    console.log(r.stdout);
    const res = path.join(out, "rec-check", "report.json");
    if (fs.existsSync(res)) {
      const j = JSON.parse(fs.readFileSync(res, "utf8"));
      for (const s of j.steps ?? []) {
        const step = steps.find((x) => x.step === s.name);
        if (step && s.pass === false) {
          step.pass = false;
          const f = s.flags.filter((x) => x.fail);
          step.sees += `; the recording: ${f
            .map((x) => `${x.kind} on ${x.region} at ${x.time} s (${x.frames} frames)`)
            .slice(0, 4)
            .join(", ")}`;
        }
      }
    } else if (r.status !== 0)
      steps.push({ step: "rec-check", pass: false, sees: "the recording check failed to run", shot: "" });
  } else if (!fs.existsSync(checker))
    console.log("tools/rec-check.mjs not on this branch: the recording is not judged");
  else
    steps.push({
      step: "recording",
      pass: false,
      sees: "no recording (ScreenCaptureKit gave none: is the screen locked?), so nothing was judged frame by frame",
      shot: "",
    });

  // clips: the steps Linda watches, and every failing one
  const clips = [];
  if (fs.existsSync(video)) {
    fs.mkdirSync(path.join(out, "clips"), { recursive: true });
    for (const m of marks) {
      const step = steps.find((s) => s.step === m.name);
      if (!KEEP_CLIPS.includes(m.name) && step?.pass !== false) continue;
      const f = path.join(out, "clips", `${m.name}.mp4`);
      execFileSync("ffmpeg", [
        "-v",
        "error",
        "-y",
        "-ss",
        String(Math.max(0, m.start - 0.5)),
        "-to",
        String(m.end + 1),
        "-i",
        video,
        "-an",
        "-c:v",
        "libx264",
        "-preset",
        "veryfast",
        "-crf",
        "26",
        f,
      ]);
      clips.push(f);
      if (step) step.clip = f;
    }
  }
  if (!stops.length && !guard()) steps.push(...stops);
  // the copies go (the screenshots, the video, its clips and marks stay); older runs' videos go
  fs.rmSync(path.join(out, "projects"), { recursive: true, force: true });
  fs.rmSync(path.join(out, "data"), { recursive: true, force: true });
  fs.rmSync(path.join(out, "cbgate.app"), { recursive: true, force: true });
  const runs = path.dirname(out);
  for (const d of fs.readdirSync(runs)) {
    const o = path.join(runs, d);
    if (o === out || !fs.statSync(o).isDirectory()) continue;
    for (const f of ["run.mp4", "clips"]) fs.rmSync(path.join(o, f), { recursive: true, force: true });
  }

  const at = (m) => {
    const t = marks.find((x) => x.name === m)?.start;
    return t == null ? "" : `${Math.floor(t / 60)}:${(t % 60).toFixed(1).padStart(4, "0")}`;
  };
  const rows = steps.map(
    (s) =>
      `| ${s.step} | ${at(s.step)} | ${s.pass ? "pass" : "FAIL"} | ${s.sees} | ${
        s.shot
          ? s.shot
              .split(" ")
              .map((p) => path.relative(root, p))
              .join(", ")
          : ""
      } |`,
  );
  const md = [
    `# macOS human-use pass ${new Date().toISOString()}`,
    "",
    `Video: ${fs.existsSync(video) ? path.relative(root, video) : "none"} (marks: ${path.relative(root, path.join(out, "marks.json"))})`,
    "",
    "| step | at | result | what a person sees | screenshot |",
    "|---|---|---|---|---|",
    ...rows,
    "",
    ...(clips.length ? ["Clips:", ...clips.map((c) => `- ${path.relative(root, c)}`)] : []),
  ].join("\n");
  fs.writeFileSync(path.join(out, "report.md"), md);
  fs.writeFileSync(path.join(out, "report.json"), JSON.stringify({ steps, marks, video, clips, rec }, null, 1));
  console.log(md);
  const pass = steps.length > 0 && steps.every((s) => s.pass);
  console.log(
    `\n${pass ? "PASS" : "FAIL"}: ${steps.filter((s) => s.pass).length}/${steps.length} steps; report ${path.relative(root, path.join(out, "report.md"))}`,
  );
  return pass;
}

function duration(f) {
  return +execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", f], {
    encoding: "utf8",
  }).trim();
}
function spawnSyncNode(script, a) {
  return spawnSync(process.execPath, [script, ...a], { encoding: "utf8" });
}

function screenLocked() {
  try {
    return /<key>CGSSessionScreenIsLocked<\/key>\s*<true\/>/.test(
      execFileSync("ioreg", ["-n", "Root", "-d1", "-a"], { encoding: "utf8" }),
    );
  } catch {
    return false;
  }
}
