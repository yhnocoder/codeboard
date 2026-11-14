// The boards of the stage 8 look sheets (the summary level), made with main's own core (emptyBoard, putSummary,
// summarySig), written to review/stage8/storage/ as main's board files: capture-main.spec.ts opens them in main's board,
// `LookCompare --stage8` imports them into a vault and draws them natively. Made-up content (the nested board is main's
// summaryNestedSections scenario's). From the repository root, after npm ci:
//   node apps/macos/review/stage8/boards.mjs
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";

const here = import.meta.dirname;
const root = path.resolve(here, "../../../..");
const out = path.join(here, "storage");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "stage8-boards-"));
const entry = path.join(tmp, "entry.ts");
const file = (p) => JSON.stringify(path.join(root, p));
fs.writeFileSync(
  entry,
  `export * from ${file("packages/core/src/summary.ts")};\nexport { emptyBoard } from ${file("packages/core/src/model.ts")};\n`,
);
const bundle = path.join(tmp, "core.mjs");
await build({ entryPoints: [entry], bundle: true, format: "esm", platform: "node", outfile: bundle, logLevel: "error" });
const C = await import(pathToFileURL(bundle).href);
fs.rmSync(tmp, { recursive: true, force: true });
const AT = 1_700_000_000_000;

const note = (id, md, look = "note") => ({ id, kind: "note", md, look });
const put = (b, c, x, y, w = 560) => {
  b.cards.push(c);
  b.place[c.id] = { x, y, w };
};
const written = (b, k, text, title) =>
  C.putSummary(b, k, { text, at: AT, sig: C.summarySig(b, k), input: C.summaryInput(b, k), ...(title ? { title } : {}) });

/** Sections three deep (main's summaryNestedSections board) */
function nested() {
  const b = C.emptyBoard("s8nested", "计算架构与调度");
  const S = (id, title, parent) => ({ id, title, x: 0, y: 0, w: 0, h: 0, ...(parent ? { parent } : {}) });
  b.sections.push(
    S("T", "计算架构"),
    S("P", "GPU 架构初探", "T"),
    S("c1", "SM 与 block 调度", "P"),
    S("c2", "barrier 与透明扩展", "P"),
    S("c3", "__syncthreads 误用示例", "P"),
    S("W", "WARP 执行", "T"),
    S("w1", "WARP 与 SIMD 硬件", "W"),
    S("w2", "WARP 控制流分歧", "W"),
    S("w3", "WARP 调度、延迟、占用率", "W"),
    S("D", "设备与资源"),
    S("q", "查询设备属性", "D"),
  );
  const cards = [
    ["c1", "现代 GPU 的架构", 63, 25, 524, "GPU 由一组高度多线程化的 SM 组成。"],
    ["c1", "thread block 调度", 617, 25, 498, "block 整块分给一个 SM。"],
    ["c2", "同步与透明可扩展性", 1203, 25, 517, "同一 block 的线程用 barrier 协调。"],
    ["c2", "barrier 应尽量限制在较小范围", 1203, 692, 524, "范围越大，等待越多。"],
    ["c3", "错误使用 __syncthreads() 的示例", 2382, 671, 292, "if 和 else 各放一个。"],
    ["P", "thread block cluster", 1807, 25, 404, "cluster 范围的 barrier。"],
    ["P", "grid 范围同步", 1807, 228, 404, "开销高于 block 和 cluster。"],
    ["P", "Intrinsic Function", 1807, 413, 404, "__syncthreads 是 intrinsic。"],
    ["P", "__syncthreads tricky 的地方", 1807, 648, 517, "每处调用都是独立的同步点。"],
    ["P", "Wave", 1807, 983, 476, "同时执行的一组 block。"],
    ["w1", "Warp", 1703, 1700, 476, "32 个线程一组。"],
    ["w1", "线程布局", 2258, 1700, 476, "row-major 展平再切。"],
    ["w1", "GPU 中的 SIMD 硬件设计", 1703, 2558, 476, "一条指令跑整个 warp。"],
    ["w2", "Wrap 控制流分歧", 2994, 1700, 381, "分支要分遍跑。"],
    ["w2", "检查是否会造成控制流分歧", 3635, 1700, 480, "看判定条件。"],
    ["w2", "控制流分歧: if-else", 2845, 2206, 387, "两边各跑一遍。"],
    ["w3", "Warp 调度与延迟容忍", 2808, 2902, 517, "等内存时换一个 warp。"],
    ["w3", "资源划分与占用率", 2808, 3626, 381, "occupancy。"],
    ["w3", "性能悬崖初探", 3698, 3626, 417, "多用一个寄存器就掉一截。"],
    ["q", "查询设备属性", 4542, 2902, 380, "cudaGetDeviceProperties。"],
    ["q", "使用 cudaDeviceProp", 4261, 3297, 450, "按资源上限调参。"],
  ];
  cards.forEach(([sec, title, x, y, w, text], i) => {
    put(b, note(`k${i}`, `## ${title}\n\n${text}`), x, y, w);
    b.place[`k${i}`].section = sec;
  });
  const inside = (sid) => cards.find((c) => c[0] === sid)?.[0] ?? inside(b.sections.find((x) => x.parent === sid).id);
  for (const sec of b.sections) {
    const c = cards.find((k) => k[0] === inside(sec.id));
    Object.assign(sec, { x: c[2], y: c[3] });
  }
  written(
    b,
    "sec:c1",
    "线程以 **thread block 为单位**分到 SM，同一 block 的线程落在同一个 SM 上，能用 barrier 和 shared memory **低延迟协作**。",
  );
  written(b, "sec:c2", "barrier 只限在 block 内，不同 block 就能按任意顺序执行，程序在大小不同的 GPU 上**透明扩展**。");
  written(b, "sec:c3", "if 和 else 两边各放一个 __syncthreads()，其实是**两个同步点**，行为未定义。");
  written(b, "sec:w1", "block 按 32 个线程切成 **warp**，是 SM 的调度单位；SIMD 让一条指令同时跑整个 warp。");
  written(b, "sec:w2", "同一 warp 的线程走不同分支时，硬件要**分遍执行**，每遍只有部分线程活动。");
  written(b, "sec:w3", "一个 warp 等内存时调度器**零开销**切到另一个，靠 warp 多来盖住延迟。");
  written(b, "sec:q", "每个设备的资源由**计算能力**决定，查 SM 数、每 block 线程上限等资源上限。");
  written(
    b,
    "own:P",
    "barrier 分三层：block 内用 __syncthreads()，cluster 和 grid 用 Cooperative Groups，**范围越大开销越高**。同时执行的一批 block 叫 wave。",
    "同步层次与 wave",
  );
  written(b, "sec:P", "SM 按块调度，barrier 只在块内，**换来透明扩展**。");
  written(b, "sec:W", "warp 一起跑、分支分遍跑，靠**多驻留 warp** 盖住延迟。");
  written(b, "sec:T", "SM 按 block 调度、barrier 只在块内，warp 是执行单位：**两层调度**决定了并行怎么写。");
  return b;
}

/** A Section with exactly one child Section (a kick line above the child's title), a Section never written (only its
 *  title), and one whose cards changed after its summary was written (the dot) */
function single() {
  const b = C.emptyBoard("s8single", "一个子 Section");
  b.sections.push(
    { id: "D", title: "设备与资源", x: 80, y: 80, w: 0, h: 0 },
    { id: "q", title: "查询设备属性", x: 80, y: 80, w: 0, h: 0, parent: "D" },
    { id: "u", title: "还没写过的 Section", x: 2200, y: 80, w: 0, h: 0 },
    { id: "st", title: "改过的 Section", x: 2200, y: 1400, w: 0, h: 0 },
  );
  const cards = [
    ["q", "查询设备属性", 80, 80, 700, "cudaGetDeviceProperties 读出每个设备的资源上限。"],
    ["q", "使用 cudaDeviceProp", 880, 80, 700, "按 SM 数和每 block 线程上限调参。"],
    ["u", "合并访存", 2200, 80, 700, "同一 warp 访问连续地址。"],
    ["u", "bank 冲突", 3000, 80, 700, "填充一列错开 bank。"],
    ["st", "流和事件", 2200, 1400, 700, "流里的操作按顺序执行。"],
    ["st", "异步拷贝", 3000, 1400, 700, "cudaMemcpyAsync 要页锁定内存。"],
  ];
  cards.forEach(([sec, title, x, y, w, text], i) => {
    put(b, note(`d${i}`, `## ${title}\n\n${text}`), x, y, w);
    b.place[`d${i}`].section = sec;
  });
  put(b, note("far", "# 远处\n\n撑开白板"), 6000, 3500, 700);
  written(b, "sec:q", "每个设备的资源由**计算能力**决定，查 SM 数、每 block 线程上限等资源上限。");
  written(b, "sec:st", "同一个流里的拷贝和 kernel **按顺序**执行，不同流之间可以**重叠**。");
  // a card renamed after it was written (pending follows the cards' titles): its dot and ✓ 保留
  b.cards.find((c) => c.id === "d5").md = "## 异步拷贝与页锁定内存\n\ncudaMemcpyAsync 要页锁定内存，否则退化成同步拷贝。";
  return b;
}

/** Cards outside Sections: a sentence each; a Text and a Box stay as they are; a code card; one never written */
function loose() {
  const b = C.emptyBoard("s8loose", "散卡");
  put(b, note("l1", "# 本章导读\n\n这一章从 CPU 和 GPU 的设计取舍讲起。"), 80, 300, 900);
  put(b, note("l2", "# 延迟与吞吐\n\nCPU 用大缓存换延迟，GPU 用大量线程换吞吐。"), 1100, 300, 900);
  put(b, note("l3", "# 还没写过\n\n这张卡没有摘要。"), 2100, 300, 900);
  put(b, note("t1", "# GPU 编程笔记", "text"), 80, 40, 1400);
  put(b, note("x1", "先看这里：**吞吐**比延迟重要", "box"), 1100, 1300, 700);
  put(b, note("far", "# 远处\n\n撑开白板"), 6000, 3500, 700);
  written(b, "card:l1", "从 CPU 和 GPU 的**设计取舍**讲起：一个押延迟，一个押吞吐。", "导读");
  written(b, "card:l2", "CPU 靠**大缓存**压低延迟，GPU 靠**海量线程**撑起吞吐。");
  return b;
}

/** Two loose cards stacked close with long summaries, and a title past two lines (main's summaryOverflowFades board) */
function overflow() {
  const b = C.emptyBoard("s8overflow", "overflow");
  const long =
    "合并访存要求同一 warp 的线程访问**连续的地址**，这样一次事务就能取回整段数据，地址分散时要拆成很多次事务。".repeat(3);
  put(b, note("a", "# 合并访存：连续地址\n\n同一 warp 访问连续地址。"), 80, 80, 700);
  put(b, note("b", "# 合并访存：对齐方式\n\n起始地址按 128 字节对齐。"), 80, 520, 700);
  put(b, note("far", "# 远处\n\n撑开白板"), 4200, 2600, 700);
  put(b, note("c", `# ${"共享内存的 bank 冲突与填充".repeat(6)}\n\n短。`), 1200, 80, 600);
  C.putSummary(b, "card:c", { text: "短。", at: AT, sig: C.summarySig(b, "card:c") });
  for (const k of ["card:a", "card:b"]) C.putSummary(b, k, { text: long, at: AT, sig: C.summarySig(b, k) });
  return b;
}

fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });
for (const b of [nested(), single(), loose(), overflow()])
  fs.writeFileSync(path.join(out, `${b.id}.json`), JSON.stringify(b, null, 1) + "\n");
console.log(`boards in ${out}`);
