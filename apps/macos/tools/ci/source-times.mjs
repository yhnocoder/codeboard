// Gives every tracked file under apps/macos a modification time made from its content, the same on every checkout
// until the file changes (.github/workflows/macos.yml, before a build that starts from an earlier run's .build).
// A checkout stamps every file with the time of the checkout, which the build takes for a change to all of them and
// compiles everything again; with these times it compiles only the files whose content differs from the kept build's.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const app = path.resolve(import.meta.dirname, "../..");
const tracked = execFileSync("git", ["-C", app, "ls-files", "-s", "-z", "."], {
  encoding: "utf8",
  maxBuffer: 64 * 1024 * 1024,
});
let count = 0;
for (const entry of tracked.split("\0").filter(Boolean)) {
  const [meta, file] = entry.split("\t");
  // the first 28 bits of the file's blob hash as seconds after 2001: a different time for a different content
  const at = 978307200 + Number.parseInt(meta.split(" ")[1].slice(0, 7), 16);
  fs.utimesSync(path.join(app, file), at, at);
  count++;
}
console.log(`${count} files given times from their content`);
