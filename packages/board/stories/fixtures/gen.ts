// SegView 只能在 Node 里算（tree-sitter、读仓库），所以和 harness 走同一条路预先算好写进 code.json，小样只读 JSON。
// 重新生成：node packages/board/stories/fixtures/gen.mjs（要先 git submodule update --init examples/nano-vllm）
import * as fs from "node:fs";
import * as path from "node:path";
import type { Segment, SegView } from "@codeboard/core";
import { ready, findSym, symCard, viewOf } from "../../test/harness";

declare const OUT_FILE: string;

const PICK = {
  schedule: "Scheduler.schedule",
  preempt: "Scheduler.preempt",
  canAppend: "BlockManager.can_append",
  // ---- Canvas（箭头、Section、LOD 的小样）：短函数，几张卡放在一块白板上也看得全
  step: "LLMEngine.step",
  canAllocate: "BlockManager.can_allocate",
  allocate: "BlockManager.allocate",
  deallocate: "BlockManager.deallocate",
  mayAppend: "BlockManager.may_append",
  // ---- Canvas 结束
} as const;

await ready();
const out: Record<string, { seg: Segment; view: SegView }> = {};
for (const [key, qual] of Object.entries(PICK)) {
  const x = findSym(qual);
  if (!x) throw new Error(`No symbol ${qual} in examples/nano-vllm (git submodule update --init examples/nano-vllm)`);
  // 段 id 固定：重新生成时 JSON 只在代码真变了时才变（symCard 每次给新的随机 id）
  const seg: Segment = { ...symCard(x.f, x.s).segments[0], id: `s-${key}` };
  out[key] = { seg, view: viewOf(seg) };
}
fs.writeFileSync(OUT_FILE, JSON.stringify(out, null, 1) + "\n");
console.log(`Wrote ${Object.keys(out).length} segments to ${path.relative(process.cwd(), OUT_FILE)}`);
