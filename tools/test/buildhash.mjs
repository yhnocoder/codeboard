// What the board build in npm run check is made from (tools/test/check.mjs skips the build when this is unchanged since the last
// one): the whole board package (sources, public/ fonts and icons, configs) except its tests and stories, the Markdown package's
// sources and configs, analysis and core sources, and the lockfile
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

const INPUTS = [
  "packages/board", ":(exclude)packages/board/test", ":(exclude)packages/board/stories", ":(exclude)packages/board/.storybook",
  "packages/markdown/src", "packages/markdown/package.json", "packages/markdown/vite.config.ts", "packages/markdown/tsconfig.json", "packages/markdown/tsconfig.build.json",
  "packages/analysis/src", "packages/core/src", "package-lock.json",
];

export function buildHash(repo) {
  const h = createHash("sha1");
  const files = execFileSync("git", ["ls-files", "-co", "--exclude-standard", "--", ...INPUTS], { cwd: repo, encoding: "utf8" }).split("\n").filter(Boolean);
  for (const f of files.sort()) { h.update(f); try { h.update(fs.readFileSync(path.join(repo, f))); } catch { /* deleted */ } }
  return h.digest("hex");
}
