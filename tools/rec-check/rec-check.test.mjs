// rec-check on small synthetic recordings: a 1-frame white flash, a card blurred for 5 frames and a card blank for 4 are each
// caught; the clean recording, still and panned, has no flag at all.
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

const W = 640;
const H = 360;
const FPS = 60;
const N = 180;
const CARDS = { a: [20, 10, 320, 200], b: [370, 10, 250, 190], c: [110, 225, 200, 135] };
const dir = mkdtempSync(join(tmpdir(), "rec-check-test-"));
const cli = join(import.meta.dirname, "..", "rec-check.mjs");
const hasFfmpeg = spawnSync("ffmpeg", ["-version"]).status === 0;

// paper with cards of text-like strokes, on a canvas wider than the frame so it can pan
function scene() {
  const cw = W + 200;
  const img = new Uint8Array(cw * H).fill(232);
  let seed = 7;
  const rnd = () => (seed = (seed * 1103515245 + 12345) >>> 0) / 2 ** 32;
  for (const [x, y, w, h] of Object.values(CARDS)) {
    for (let j = y; j < y + h; j++) img.fill(250, j * cw + x, j * cw + x + w);
    for (let line = y + 12; line < y + h - 12; line += 14)
      for (let gx = x + 10; gx < x + w - 10; gx += 6) {
        if (rnd() < 0.2) continue;
        const gh = 4 + Math.floor(rnd() * 6);
        for (let j = line; j < line + gh; j++) for (let k = gx; k < gx + 3; k++) if (rnd() < 0.8) img[j * cw + k] = 40;
      }
  }
  return { img, cw };
}

function render(file, { defects = false, pan = false } = {}) {
  const { img, cw } = scene();
  const frames = [];
  for (let n = 0; n < N; n++) {
    const dx = pan ? Math.min(Math.max(n - 60, 0), 60) * 2 : 0;
    const f = new Uint8Array(W * H);
    for (let y = 0; y < H; y++) f.set(img.subarray(y * cw + dx, y * cw + dx + W), y * W);
    if (defects && n === 60) f.fill(255);
    if (defects && n >= 90 && n < 95) blur(f, CARDS.b);
    if (defects && n >= 140 && n < 144) {
      const [x, y, w, h] = CARDS.c;
      for (let j = y; j < y + h; j++) f.fill(250, j * W + x, j * W + x + w);
    }
    frames.push(f);
  }
  execFileSync(
    "ffmpeg",
    ["-v", "error", "-y", "-f", "rawvideo", "-pix_fmt", "gray", "-s", `${W}x${H}`, "-r", String(FPS), "-i", "-"].concat(
      ["-c:v", "libx264", "-preset", "veryfast", "-crf", "16", "-pix_fmt", "yuv420p", file],
    ),
    { input: Buffer.concat(frames) },
  );
  return file;
}

function blur(f, [x, y, w, h]) {
  const src = f.slice();
  for (let j = y + 2; j < y + h - 2; j++)
    for (let i = x + 2; i < x + w - 2; i++) {
      let s = 0;
      for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) s += src[(j + dy) * W + i + dx];
      f[j * W + i] = s / 25;
    }
}

function check(video, args = []) {
  const out = join(dir, `out-${Math.random().toString(36).slice(2)}`);
  const r = spawnSync(process.execPath, [cli, video, "--out", out, ...args], { encoding: "utf8" });
  if (r.status === 2 || !r.stdout) throw new Error(r.stderr);
  return {
    status: r.status,
    report: JSON.parse(readFileSync(join(out, "report.json"), "utf8")),
    files: readdirSync(out),
  };
}

describe.skipIf(!hasFfmpeg)("rec-check", () => {
  afterAll(() => process.env.KEEP || rmSync(dir, { recursive: true, force: true }));
  const marks = join(dir, "marks.json");
  writeFileSync(
    marks,
    JSON.stringify([
      { name: "open", start: 0, end: 1.4 },
      { name: "edit", start: 1.4, end: 3 },
    ]),
  );

  it("catches the white flash, the blurred card and the blank card", () => {
    const { status, report, files } = check(render(join(dir, "bad.mp4"), { defects: true }), ["--marks", marks]);
    expect(status).toBe(1);
    const [open, edit] = report.steps;
    const fails = (s, kind) => s.flags.filter((f) => f.fail && f.kind === kind);
    expect(fails(open, "white").map((f) => [f.frame, f.frames])).toEqual([[60, 1]]);
    expect(fails(open, "flash").length).toBeGreaterThan(0);
    expect(fails(open, "flash").every((f) => f.frame === 60 && f.frames === 1)).toBe(true);
    const blurred = fails(edit, "blur");
    // card c's blanking also dulls the tile it half covers, so a blur flag at 140 is expected too
    expect(blurred.filter((f) => f.frame === 90).map((f) => f.frames)).toEqual([5]);
    const blank = fails(edit, "blank");
    expect(blank.length).toBeGreaterThan(0);
    expect(blank.every((f) => f.frame === 140 && f.frames === 4)).toBe(true);
    // nothing outside the defects
    for (const s of report.steps) for (const f of s.flags) expect([60, 90, 140]).toContain(f.frame);
    expect(files.sort()).toEqual([
      "clip-edit-1.mp4",
      "clip-edit-2.mp4",
      "clip-open-1.mp4",
      "report.json",
      "report.md",
      "sheet-edit.png",
      "sheet-open.png",
    ]);
  });

  it("has no flag on a clean recording", () => {
    const { status, report } = check(render(join(dir, "clean.mp4")), ["--marks", marks]);
    expect(report.steps.flatMap((s) => s.flags)).toEqual([]);
    expect(status).toBe(0);
  });

  it("has no flag on a clean pan judged as moving", () => {
    const { status, report } = check(render(join(dir, "pan.mp4"), { pan: true }), ["--moving", "0.98-2.02"]);
    expect(report.steps.flatMap((s) => s.flags)).toEqual([]);
    expect(status).toBe(0);
  });
});
