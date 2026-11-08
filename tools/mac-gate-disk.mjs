// The macOS gate's disk guards (tools/mac-gate.mjs): an Animation Hitches recording once filled a disk (39 GB for one run), so
// the recording is short and holds only the Hitches instrument, it goes as soon as its table is exported, and the run stops
// when the disk runs low or the run's own output grows past its cap.
import fs from "node:fs";
import path from "node:path";

const GB = 2 ** 30;

/** Free space on the volume that holds dir, in GB */
export function freeGB(dir) {
  const s = fs.statfsSync(dir);
  return (s.bavail * s.bsize) / GB;
}

/** The bytes under dir (files only; links not followed), in GB; 0 when it is not there */
export function sizeGB(dir) {
  let n = 0;
  const walk = (p) => {
    let st;
    try {
      st = fs.lstatSync(p);
    } catch {
      return;
    }
    if (st.isDirectory()) for (const f of fs.readdirSync(p)) walk(path.join(p, f));
    else n += st.size;
  };
  walk(dir);
  return n / GB;
}

/** Why the run must stop now (free space under minFree GB, or more than maxOut GB written), or null */
export function diskStop({ free, used }, { minFree, maxOut }) {
  if (free < minFree) return `only ${free.toFixed(1)} GB free on the disk (the gate needs ${minFree} GB)`;
  if (used > maxOut) return `the run wrote ${used.toFixed(2)} GB (the cap is ${maxOut} GB)`;
  return null;
}

/** xctrace's arguments for a recording of pid by the Hitches instrument alone (the Animation Hitches template adds the system
 *  trace's instruments, which are most of its size), ended by xctrace itself after limitS seconds */
export function hitchesRecord(pid, output, limitS) {
  return [
    "xctrace",
    "record",
    "--instrument",
    "Hitches",
    "--attach",
    String(pid),
    "--output",
    output,
    "--time-limit",
    `${limitS}s`,
    "--no-prompt",
  ];
}

/** After the report: a board's capture folders go (one per step, beside run.json); fails/ and the files stay */
export function dropCaptures(dir) {
  for (const f of fs.readdirSync(dir, { withFileTypes: true }))
    if (f.isDirectory() && f.name !== "fails") fs.rmSync(path.join(dir, f.name), { recursive: true, force: true });
}
