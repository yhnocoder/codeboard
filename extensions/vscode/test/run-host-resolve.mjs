// 打包 host-resolve.ts（vscode 换成假的）给 Node 跑：没有语言服务时宿主的展开 / 预览 / 变量候选。用法：node run-host-resolve.mjs
import { build } from "esbuild";
import { execFileSync } from "node:child_process";
import * as path from "node:path";
const here = path.dirname(new URL(import.meta.url).pathname);
const out = path.join(here, "../../../test-out/host-resolve.cjs");
await build({ entryPoints: [path.join(here, "host-resolve.ts")], bundle: true, platform: "node", format: "cjs", outfile: out, alias: { vscode: path.join(here, "vscode-stub.ts") }, external: ["@vscode/tree-sitter-wasm"], logLevel: "error" });
execFileSync("node", [out], { stdio: "inherit" });
