// npm run build -w @codeboard/box: the Rust binary (cargo build --release, incremental) copied to bin/<platform>-<arch>/box[.exe],
// where the host's tests and the extension's build find it. Without cargo it says so and builds nothing (Related by Meaning is
// then off), except in CI, where that fails. BOX_PREBUILT=1: bin/ already holds them (release.yml), nothing is built.
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

const DIR = import.meta.dirname;
if (process.env.BOX_PREBUILT) {
  console.log("box: BOX_PREBUILT is set, using the binaries already in bin/");
  process.exit(0);
}
const cargo = spawnSync("cargo", ["--version"], { stdio: "ignore" });
if (cargo.error || cargo.status) {
  const msg = "cargo not found: the box binary is not built, so Related by Meaning is off. Install Rust (https://rustup.rs) to build it.";
  if (process.env.CI) {
    console.error(msg);
    process.exit(1);
  }
  console.warn(`warning: ${msg}`);
  process.exit(0);
}
const locked = process.env.CI ? ["--locked"] : []; // CI builds exactly Cargo.lock
const r = spawnSync("cargo", ["build", "--release", "--quiet", "--bin", "box", ...locked], { cwd: DIR, stdio: "inherit" });
if (r.status) process.exit(r.status ?? 1);
const exe = process.platform === "win32" ? "box.exe" : "box";
// as binIn (src/index.ts) finds it
const out = path.join(DIR, "bin", `${process.platform}-${process.arch}`, exe);
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.copyFileSync(path.join(DIR, "target", "release", exe), out);
