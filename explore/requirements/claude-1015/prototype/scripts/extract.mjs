// 从本地 nano-vllm 仓库导出原型用的源码快照。
// 用法：node scripts/extract.mjs <nano-vllm 仓库路径>
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";

const repo = process.argv[2];
if (!repo) {
  console.error("用法：node scripts/extract.mjs <nano-vllm 仓库路径>");
  process.exit(1);
}
const git = (...args) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8", maxBuffer: 1 << 26 });

// HEAD 是工作区当前版本；OLD 是「两周前」建卡片时钉住的版本，用来演示「有新版本」。
const COMMITS = ["bb823b3", "9e8507e"];
const commits = COMMITS.map((sha) => {
  const [full, date, subject] = git("log", "-1", "--format=%H%x00%ad%x00%s", "--date=short", sha).trim().split("\0");
  return { sha: full, short: sha, date, subject };
});

const files = {};
for (const c of COMMITS) {
  const paths = git("ls-tree", "-r", "--name-only", c).split("\n")
    .filter((p) => p.startsWith("nanovllm/") && p.endsWith(".py") || p === "example.py" || p === "bench.py");
  files[c] = {};
  for (const p of paths) files[c][p] = git("show", `${c}:${p}`);
}
// 旧版本只保留和 HEAD 不同的文件，其余回落到 HEAD。
for (const p of Object.keys(files[COMMITS[1]])) {
  if (files[COMMITS[1]][p] === files[COMMITS[0]][p]) delete files[COMMITS[1]][p];
}

const out = { name: "nano-vllm", url: "https://github.com/GeeeekExplorer/nano-vllm", head: COMMITS[0], commits, files };
writeFileSync(new URL("../src/data/nanovllm.json", import.meta.url), JSON.stringify(out));
console.log("wrote", Object.keys(files[COMMITS[0]]).length, "files at HEAD,", Object.keys(files[COMMITS[1]]).length, "changed at old commit");
