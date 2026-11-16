// Fetches what the saving service ships beside its Swift package, from the release of the version Package.resolved
// pins, into apps/macos/.build-shiyi: `shiyi`, the service's executable, and `scripts/`, its page scripts (hooks.js,
// capture.js, reader.js). make-app.sh and the acceptance runner carry both in the app's Contents/Resources when they
// are there; the tests that run the real service read them from here. The repository is private: curl signs in with
// the netrc file resolve.sh uses too (SHIYI_NETRC, else ~/.config/codeboard/shiyi.netrc), which it reads itself, so
// no token passes through this script
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repo = "yhnocoder/shiyi";
const here = dirname(fileURLToPath(import.meta.url));
const mac = join(here, "../..");
const out = join(mac, ".build-shiyi");
const pin = JSON.parse(readFileSync(join(mac, "Package.resolved"), "utf8")).pins.find((p) => p.identity === "shiyi");
if (!pin?.state.version) throw new Error("Package.resolved pins no version of shiyi");
const version = pin.state.version;
// release asset → what it becomes here
const wanted = { "shiyi-macos-arm64": "shiyi", "shiyi-webview.zip": "webview.zip" };

const sha256 = (file) => createHash("sha256").update(readFileSync(file)).digest("hex");

/** The netrc file curl signs in with, checked as resolve.sh checks it: there, and readable by its owner alone */
function netrc() {
  const file = process.env.SHIYI_NETRC || join(homedir(), ".config/codeboard/shiyi.netrc");
  if (!existsSync(file)) {
    console.error(`${file} is missing: make it (mode 600) with the one line`);
    console.error("  machine api.github.com login <user> password <token>");
    process.exit(1);
  }
  if (statSync(file).mode & 0o077) {
    console.error(`${file} can be read by others: chmod 600 ${file}`);
    process.exit(1);
  }
  return file;
}

/** Each wanted asset's name, size, sha256 and API address, as the release lists them */
function release(auth) {
  const url = `https://api.github.com/repos/${repo}/releases/tags/${version}`;
  const { assets } = JSON.parse(execFileSync("curl", ["-fsSL", "--netrc-file", auth, url]).toString());
  return Object.keys(wanted).map((name) => {
    const a = assets.find((x) => x.name === name);
    if (!a) throw new Error(`release ${version} of ${repo} has no ${name}`);
    return { name, size: a.size, sha256: a.digest?.replace(/^sha256:/, ""), api: a.url };
  });
}

/** Whether the file has what the release says of it: its size, and its sha256 when the release gives one */
const matches = (file, a) =>
  existsSync(file) && readFileSync(file).length === a.size && (!a.sha256 || sha256(file) === a.sha256);

const record = join(out, "release.json");
const kept = existsSync(record) ? JSON.parse(readFileSync(record, "utf8")) : null;
const scripts = join(out, "scripts");
const ready = (assets) =>
  assets.every((a) => matches(join(out, wanted[a.name]), a)) &&
  ["hooks.js", "capture.js", "reader.js"].every((f) => existsSync(join(scripts, f)));
if (kept?.version === version && ready(kept.assets)) {
  console.log(`shiyi ${version}: already in ${out}`);
  process.exit(0);
}

const auth = netrc();
const assets = release(auth);
mkdirSync(out, { recursive: true });
// each download into a folder of its own, moved into place only once it checks out
const incoming = join(out, "incoming");
for (const a of assets) {
  const file = join(out, wanted[a.name]);
  if (matches(file, a)) continue;
  rmSync(incoming, { recursive: true, force: true });
  mkdirSync(incoming);
  const got = join(incoming, a.name);
  // (curl signs in to api.github.com only; the address it is sent on to is signed already)
  execFileSync("curl", ["-fsSL", "--netrc-file", auth, "-H", "Accept: application/octet-stream", "-o", got, a.api]);
  if (!matches(got, a)) throw new Error(`${a.name}: not the ${a.size} bytes${a.sha256 ? ` of sha256 ${a.sha256}` : ""} the release lists`);
  renameSync(got, file);
  console.log(`fetched ${a.name} (${a.size} bytes)`);
}
rmSync(incoming, { recursive: true, force: true });
chmodSync(join(out, "shiyi"), 0o755);
rmSync(scripts, { recursive: true, force: true });
mkdirSync(scripts);
// -j: the scripts at the folder's top, whatever folder the zip has them in
execFileSync("unzip", ["-q", "-j", "-o", join(out, "webview.zip"), "*.js", "-d", scripts]);
for (const f of ["hooks.js", "capture.js", "reader.js"])
  if (!existsSync(join(scripts, f))) throw new Error(`shiyi-webview.zip of ${version} has no ${f}`);
writeFileSync(record, `${JSON.stringify({ version, assets }, null, 2)}\n`);
console.log(`shiyi ${version}: ${out}`);
