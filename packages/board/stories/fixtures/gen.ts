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
  // Code 和 Canvas 小样共用：调用图、Compare、类卡、多段卡、箭头、LOD
  step: "LLMEngine.step",
  postprocess: "Scheduler.postprocess",
  canAllocate: "BlockManager.can_allocate",
  allocate: "BlockManager.allocate",
  deallocate: "BlockManager.deallocate",
  mayAppend: "BlockManager.may_append",
  runnerCall: "ModelRunner.call",
  runnerLoop: "ModelRunner.loop",
  runnerRun: "ModelRunner.run",
  prepareDecode: "ModelRunner.prepare_decode",
  capture: "ModelRunner.capture_cudagraph",
  blockManager: "BlockManager",
  context: "Context",
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

// 白板把 Note 的代码块交给宿主着色（cm/load.ts noteHighlight → views）；这里用宿主同一个 highlight 预先算好，假宿主按「语言 + 代码」查表
{
  const { highlight } = await import("@codeboard/host/testing");
  // C / C++ / CUDA 的着色用宿主的 tree-sitter，要它先起来
  await (await import("@codeboard/host/testing")).startAnalysis();
  const { langId } = await import("@codeboard/analysis/langs");
  const { NOTE_CODE, NOTE_CODE_EXTRA, noteCodeKey } = await import("./notecode");
  const notes: Record<string, string[]> = {};
  for (const [lang, text] of [...Object.entries(NOTE_CODE), ...NOTE_CODE_EXTRA]) {
    if (!lang) continue;
    const id = langId(lang);
    // shiki 每行有分词时限（tokenizeTimeLimit，500ms）：语法的正则第一次用到时才编译，第一次分词会超时，超时的那行整行一个颜色或不着色。
    // 先拿同样的代码多一行（宿主按文本缓存，不会命中）空跑一遍把正则都编译好，再算要的那份：每次生成都一样，都是完整着色
    await highlight([...text.split("\n"), ""], id);
    notes[noteCodeKey(id, text)] = await highlight(text.split("\n"), id);
  }
  const file = path.join(path.dirname(OUT_FILE), "notecode.json");
  fs.writeFileSync(file, JSON.stringify(notes, null, 1) + "\n");
  console.log(`Wrote ${Object.keys(notes).length} Note code blocks to ${path.relative(process.cwd(), file)}`);
}
