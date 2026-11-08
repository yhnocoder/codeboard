// npm run build -w @codeboard/box: the Rust binary (cargo build --release, incremental) copied to bin/<platform>-<arch>/box[.exe],
// where the host's tests and the extension's build find it, and the Node addon (the index in one process, node/) copied to
// node/bin/<platform>-<arch>/box.node, where src/embedded.ts and its test find it (not in the extension: CodeBoard uses the service). Without cargo it says so and builds nothing (Related by Meaning is
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
const r = spawnSync("cargo", ["build", "--release", "--quiet", "-p", "box", "-p", "box-node", ...locked], {
  cwd: DIR,
  stdio: "inherit",
});
if (r.status) process.exit(r.status ?? 1);
const platform = `${process.platform}-${process.arch}`;
const release = path.join(DIR, "target", "release");
const exe = process.platform === "win32" ? "box.exe" : "box";
const addon = { win32: "box_node.dll", darwin: "libbox_node.dylib" }[process.platform] ?? "libbox_node.so";
// as binIn (src/index.ts) and addonIn (src/embedded.ts) find them
for (const [from, to] of [
  [exe, path.join(DIR, "bin", platform, exe)],
  [addon, path.join(DIR, "node", "bin", platform, "box.node")],
]) {
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.copyFileSync(path.join(release, from), to);
}
