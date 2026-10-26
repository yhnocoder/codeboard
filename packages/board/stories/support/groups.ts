// 各张卡的 Overview 摆法：卡的 story 和 Overview/All 共用，All 把它们放在同一块白板上
import { HAND_COLORS, type HandColor, type Stale } from "@codeboard/core";
import { noteCard, codeCard, markCard, annotAt, type Group } from "./board";

export const SHORT = "KV cache 按 block 分配，一个 block 256 个 token。";
export const LONG = [
  "# Scheduler.schedule",
  "",
  "每一步先排 **prefill**：等待队列里的请求按顺序拿 block，直到 token 数或序列数到上限。",
  "",
  "- 第一个请求可以 chunked prefill：只排一部分 token",
  "- 拿不到 block 就停，等下一步",
  "- 已经有 block table 的（被抢占过的）只补没算过的 token",
  "",
  "没有可排的 prefill 时才排 **decode**：每个正在跑的请求排一个 token；block 不够就抢占最后进来的请求（`preempt`），",
  "它的 block 全部释放，回到等待队列最前面。",
  "",
  "## 为什么先 prefill",
  "",
  "prefill 的 token 多，一步算得满；decode 每个请求只有一个 token，攒多一点再算更划算。",
  "这样 GPU 一直有活干，等待的请求也不会饿着。",
].join("\n");
export const TITLED = "# Block Manager\n\n管 KV cache 的 block：分配、释放、按 hash 复用前缀。";
export const RICH = [
  "注意力的开销是 $O(n^2 d)$，每个 token 的 KV 占 $2 \\cdot L \\cdot h \\cdot d$ 个数。",
  "",
  "```python",
  "num_blocks = (seq.num_tokens + block_size - 1) // block_size",
  "```",
  "",
  "![KV cache blocks](assets/kv-blocks-320x120.png)",
  "",
  "{prefix caching|按 block 的 hash 复用前缀} 让相同的 system prompt 只算一次。",
].join("\n");

export const ONE = "先排 prefill";
export const MANY = "block 不够就抢占最后进来的请求，它回到等待队列最前面";

export const changed: Stale = { state: "changed", hiddenOnly: false, head: "f64d821" };

// 白板上同一时刻只能有一张卡在编辑，所以编辑中的那张由调用方决定要不要放
export function noteGroup(g: Group, a: { w: number; h: number }) {
  const { put, caption } = g;
  const col = (i: number) => 40 + i * (a.w + 60);
  caption("Empty", col(0), 40); put(noteCard("n-empty", ""), { x: col(0), y: 40, w: a.w });
  caption("Short", col(0), 220); put(noteCard("n-short", SHORT), { x: col(0), y: 220, w: a.w });
  caption("Titled (heading in the header)", col(0), 420); put(noteCard("n-titled", TITLED), { x: col(0), y: 420, w: a.w });
  caption("Long (fixed height, scrolls)", col(1), 40); put(noteCard("n-long", LONG), { x: col(1), y: 40, w: a.w, h: a.h });
  caption("Math, code, image, annotation", col(2), 40); put(noteCard("n-rich", RICH), { x: col(2), y: 40, w: a.w + 40 });
  caption("Selected", col(1), a.h + 120); put(noteCard("n-sel", SHORT), { x: col(1), y: a.h + 120, w: a.w });
  caption("Editing", col(2), 620); put(noteCard("n-edit", TITLED), { x: col(2), y: 620, w: a.w + 40 });
  return { sel: "n-sel", editing: "n-edit" };
}

export function codeGroup(g: Group, a: { w: number; annot: string; annotColor: HandColor }) {
  const { put, caption } = g;
  // 从 y = 80 起：上面留给「有新版本」的横幅
  const y = 80, c2 = a.w + 80, c3 = 2 * a.w + 120;
  caption("Scheduler.schedule", 40, y); put(codeCard("c-default", "schedule"), { x: 40, y, w: a.w });
  caption("Annotations on the code", c2, y);
  put(codeCard("c-annot", "schedule", { annots: (s) => [...annotAt(s, "self.waiting", "还没跑的请求"), ...annotAt(s, "num_cached_blocks", a.annot, { color: a.annotColor, below: true })] }), { x: c2, y, w: a.w, h: 300 });
  caption("New version (amber dot)", c2, y + 430);
  const stale = put(codeCard("c-stale", "canAppend"), { x: c2, y: y + 430, w: a.w });
  caption("Narrow", c3, y, 200); put(codeCard("c-narrow", "preempt"), { x: c3, y, w: 200 });
  caption("Selected", c3, y + 260); put(codeCard("c-sel", "preempt"), { x: c3, y: y + 260, w: 280 });
  return { stale: { [stale.segments[0].id]: changed }, sel: "c-sel" };
}

export function markGroup(g: Group, a: { color: HandColor; w: number }, o: { editing: boolean }) {
  const { put, caption } = g;
  HAND_COLORS.forEach((k, i) => {
    caption(k[0].toUpperCase() + k.slice(1), 40 + i * 220, 40, 200);
    put(markCard(`m-${k}`, ONE, k), { x: 40 + i * 220, y: 40, w: 200 });
  });
  caption("One line (wide)", 40, 200, 400); put(markCard("m-wide", MANY, a.color), { x: 40, y: 200, w: 620 });
  caption("Wrapped (narrow)", 700, 200); put(markCard("m-narrow", MANY, a.color), { x: 700, y: 200, w: a.w });
  // 选中时颜色条在卡上方，名字再往上让开
  caption("Selected (toolbar, handle)", 40, 384); put(markCard("m-sel", ONE, a.color), { x: 40, y: 420, w: 220 });
  if (o.editing) { caption("Editing", 420, 420); put(markCard("m-edit", ONE, a.color), { x: 420, y: 420, w: 220 }); }
  return { sel: "m-sel", editing: o.editing ? "m-edit" : undefined };
}
