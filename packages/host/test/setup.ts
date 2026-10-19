// Once per test run: the copy of nano-vllm the host tests read (node-workspace.ts WS), cloned from the examples/nano-vllm submodule
import * as fs from "node:fs";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { WS } from "./node-workspace";

export default function setup() {
  const src = path.resolve(__dirname, "../../../examples/nano-vllm");
  if (!fs.existsSync(path.join(src, ".git"))) throw new Error("examples/nano-vllm is not checked out: run git submodule update --init examples/nano-vllm");
  if (!fs.existsSync(WS)) execFileSync("git", ["clone", "-q", src, WS]);
}
