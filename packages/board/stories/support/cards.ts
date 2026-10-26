// 非代码卡（Note、Text、Mark、Image、Web、子白板）小样共用的：舞台的补充（设置、骨架、共享、抓取中、镜头）、内容、假宿主的补充回复、play 的小工具
import { createEffect, createMemo, on } from "solid-js";
import {
  emptyBoard, skeletonOf, type Board, type BoardCard, type ImageCard, type LinksCard, type LinkItem, type NoteCard, type Settings, type SharedInfo,
  type Skeleton, type WebCard, type WebMeta, type WebStyle, type AskType, type Segment,
} from "@codeboard/core";
import { onHost } from "../../src/hostio";
import { state } from "../../src/state/store";
import { setCam, cam } from "../../src/state/camera";
import { setFetchingKeys } from "../../src/state/web";
import { Stage, codeCard, type Globals, type Scene } from "./board";
import { NOTE_CODE, noteCodeKey } from "../fixtures/notecode";
import NOTE_HTML from "../fixtures/notecode.json";

export type CardScene = Scene & {
  /** 合进宿主设置（init 之后再发一条 host，和用户在设置页改了一样） */
  settings?: Partial<Settings>;
  /** 宿主推来的子白板骨架；null = 那块白板没了；不给 = 还在等（Loading…） */
  skels?: Record<string, Skeleton | null>;
  /** 宿主算好的共享卡情况（在几块白板上、别的白板连进来的箭头） */
  shared?: Record<string, SharedInfo>;
  /** 正在抓网页信息的 Web 卡（或 Link List 的「卡 id/行 id」） */
  fetching?: string[];
  /** 盖过工具栏的缩放（工具栏只有 100 / 60 / 30，地图档要 25% 以下） */
  zoom?: number;
  /** 卡画出来以后再做的（进别的编辑、设拖放目标这类 src/state 里的 setter） */
  after?: () => void;
};

// Stage 的 init 会把设置、骨架、共享都重置：这些等它发完 init（同一轮的微任务）再补上
export function CardStage(p: { scene: () => CardScene; globals: Globals }) {
  const sc = createMemo(p.scene);
  const extra = (s: CardScene) => queueMicrotask(() => {
    if (s.settings) onHost({ type: "host", host: { settings: { ...state.host.settings, ...s.settings } } });
    if (s.skels) onHost({ type: "skeletons", boards: s.skels });
    if (s.shared) onHost({ type: "sharedInfo", cards: s.shared });
    setFetchingKeys(new Set(s.fetching ?? []));
    if (s.zoom) setCam(cam.x, cam.y, s.zoom);
    if (s.after) requestAnimationFrame(s.after);
  });
  createEffect(on(sc, extra));
  return <Stage scene={sc} globals={p.globals} />;
}

// ---------- 假宿主的补充回复 ----------

// support/host.ts 换掉了 __cbSent 的 push：再包一层，这里登记的 ask 由这里回，其余照旧交给它
type Reply = (m: any) => unknown;
/** 不回：等的那个状态一直留着（Fetching…） */
export const PENDING = Symbol("pending");
/** 这条不归这里管，交给 support/host.ts */
export const PASS = Symbol("pass");
const EXTRA: Partial<Record<AskType, Reply>> = {};
export function hostReply<K extends AskType>(type: K, f: Reply) { EXTRA[type] = f; }
{
  const sent = window.__cbSent!;
  const base = sent.push.bind(sent);
  sent.push = (...ms: unknown[]) => {
    const rest: unknown[] = [];
    for (const m of ms) {
      const q = m as { type: AskType; req?: number };
      const f = typeof q.req === "number" ? EXTRA[q.type] : undefined;
      const data = f ? f(q) : PASS;
      if (data === PASS) { rest.push(m); continue; }
      Array.prototype.push.call(sent, m);
      if (data !== PENDING) window.postMessage({ type: "reply", req: q.req, data: data ?? null }, "*");
    }
    return rest.length ? base(...rest) : sent.length;
  };
}

// Note 代码块的着色：宿主用 shiki 做，这里查 gen.ts 预先算好的表（fixtures/notecode.json）；查不到的照旧交给 support/host.ts
hostReply("views", (m: { segs: Segment[] }) => {
  if (!m.segs.every((s) => s.id === "note-code")) return PASS;
  return Object.fromEntries(m.segs.flatMap((s) => {
    const html = (NOTE_HTML as Record<string, string[]>)[noteCodeKey(s.lang, s.text.join("\n"))];
    return html ? [[s.id, { html, flags: html.map(() => 0), calls: [], defs: [], bare: {} }]] : [];
  }));
});

// ---------- 内容 ----------

/** 每一级标题各一行，下面一句正文：看各级字号和间距 */
export const HEADINGS = [
  "# H1 · Block Manager",
  "## H2 · allocate",
  "### H3 · can_allocate",
  "#### H4 · hash_blocks",
  "##### H5 · ref_count",
  "###### H6 · free_block_ids",
  "",
  "正文：一个 block 256 个 token，prefix 命中时 `ref_count += 1`。",
].join("\n");

/** Markdown 的每一种写法，一种一段（Note Markdown 的 Overview 和单个 story 共用） */
export const MD = {
  inline: "**粗体** · *斜体* · ~~删除线~~ · `inline code` · ==highlight== · <kbd>⌘</kbd><kbd>↵</kbd> · :rocket: · 链接 [nano-vllm](https://github.com/GeeeekExplorer/nano-vllm)",
  lists: [
    "- prefill：整个 prompt",
    "- decode：每步一个 token",
    "  - 抢占时回到 waiting",
    "    - block 全部释放",
    "",
    "1. `can_allocate(seq)`",
    "2. `allocate(seq)`",
    "3. `may_append(seq)`",
  ].join("\n"),
  tasks: ["- [ ] check `can_allocate(seq)`", "- [x] 按 hash 复用前缀块", "  - [x] 命中就 `ref_count += 1`", "- [ ] CUDA graph 捕获 decode"].join("\n"),
  table: ["| 阶段 | 每步 token | KV 写入 |", "| --- | :---: | ---: |", "| prefill | 整个 prompt | 全部 |", "| decode | 1 | 1 slot |", "| preempt | 0 | 释放 |"].join("\n"),
  quote: ["> 没有可排的 prefill 时才排 decode。", ">", "> > 嵌套引用：block 不够就抢占最后进来的请求。", "", "---", "", "分隔线下面的正文。"].join("\n"),
  refs: "看 [[Scheduler.schedule]] 怎么排 prefill，再看 [[BlockManager.allocate]]（这张白板上没有，显示成缺失）。",
  math: ["行内 $O(n^2 d)$，每个 token 的 KV 占 $2 \\cdot L \\cdot h \\cdot d$ 个数。", "", "$$", "\\text{blocks} = \\left\\lceil \\frac{\\text{num\\_tokens}}{\\text{block\\_size}} \\right\\rceil", "$$"].join("\n"),
  image: "![KV cache blocks](assets/kv-blocks-320x120.png)\n\n图下面的说明文字。",
  annot: "{Scheduler|决定谁先跑} 每步调一次；{one forward pass|prefill or decode|purple below} 里 {block_table|按 hash 复用|orange} 和 {slot_mapping|写 KV 的位置|green}。",
  footnote: ["抢占的请求回到 waiting 最前面[^1]。", "", "[^1]: 它的 block 全部释放，下次重新 prefill。"].join("\n"),
  details: ["<details>", "<summary>为什么 __init__ 慢</summary>", "", "因为 __init__ 先建好所有 Block。", "", "</details>"].join("\n"),
  mermaid: ["```mermaid", "graph LR", "  W[waiting] -->|allocate| R[running]", "  R -->|preempt| W", "  R -->|finish| F[finished]", "```"].join("\n"),
  toc: "[toc]\n\n## Prefill\n\n## Decode",
};
export type MdKey = keyof typeof MD;

export const CODE_LANGS = NOTE_CODE;
export const codeBlock = (lang: string) => `\`\`\`${lang}\n${CODE_LANGS[lang]}\n\`\`\``;

/** 所有写法拼在一张 Note 里 */
export const ALL_MD = [
  "# KV cache 笔记", "", MD.inline, "", MD.lists, "", MD.tasks, "", MD.table, "", MD.quote, "", MD.refs, "", MD.math, "", codeBlock("python"), "", MD.image, "", MD.annot, "", MD.footnote, "", MD.details,
].join("\n");

export const noteAt = (id: string, md: string, o: Partial<NoteCard> = {}): NoteCard => ({ id, kind: "note", md, bg: true, ...o });

// ---------- 图片 ----------

const svgUrl = (s: string) => `data:image/svg+xml;base64,${btoa(s)}`;
const BROKEN = "data:image/png;base64,AAAA";
const blocks = (w: number, h: number, a: string, b: string, label: string) => svgUrl(
  `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${a}"/><stop offset="1" stop-color="${b}"/></linearGradient></defs>` +
  `<rect width="${w}" height="${h}" fill="url(#g)"/>` +
  Array.from({ length: 8 }, (_, i) => `<rect x="${w * 0.08 + i * w * 0.105}" y="${h * 0.42}" width="${w * 0.085}" height="${h * 0.22}" rx="3" fill="${i < 3 ? "#fff" : "none"}" fill-opacity=".85" stroke="#fff" stroke-width="2"/>`).join("") +
  `<text x="${w * 0.08}" y="${h * 0.25}" font-family="Helvetica, Arial" font-size="${Math.round(Math.min(w, h) * 0.08)}" fill="#fff">${label}</text></svg>`,
);
export const IMAGES = {
  wide: blocks(640, 240, "#3b5b8c", "#7a9fd1", "KV cache: 8 blocks, 3 used"),
  square: blocks(400, 400, "#8c5b3b", "#d1a07a", "block table"),
  tall: blocks(260, 520, "#3b7a5b", "#7ad1a0", "waiting queue"),
  asset: "kv-blocks-320x120.png",
  // 解不出来的图（不用不存在的文件：那样每次都有一条 404 进控制台）
  broken: BROKEN,
} as const;
export type ImageKey = keyof typeof IMAGES;
export const imageCard = (id: string, src: string, o: Partial<ImageCard> = {}): ImageCard => ({ id, kind: "image", src, alt: "KV cache blocks", ...o });

// ---------- 网页 ----------

const fav = (c: string, t: string) => svgUrl(`<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><rect width="32" height="32" rx="7" fill="${c}"/><text x="16" y="22" font-family="Arial" font-weight="700" font-size="17" fill="#fff" text-anchor="middle">${t}</text></svg>`);
const og = (a: string, b: string, t: string, w = 600, h = 315) => svgUrl(`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${a}"/><stop offset="1" stop-color="${b}"/></linearGradient></defs><rect width="${w}" height="${h}" fill="url(#g)"/><text x="30" y="${h * 0.58}" font-family="Georgia" font-size="${Math.round(h * 0.13)}" fill="#fff">${t}</text></svg>`);

/** 假网页：网址 → 抓到的信息（和 test/scenarios/web.spec.ts 同一批） */
export const PAGES = {
  /** 全的，横图 */
  full: { url: "https://arxiv.org/abs/2309.06180", meta: { title: "Efficient Memory Management for Large Language Model Serving with PagedAttention", desc: "High throughput serving of large language models (LLMs) requires batching sufficiently many requests at a time. However, existing systems struggle because the key-value cache memory for each request is huge.", site: "arXiv.org", icon: fav("#b31b1b", "a"), image: og("#3b2a6b", "#7a5bd1", "PagedAttention") } },
  /** 方图（放右栏） */
  square: { url: "https://flashinfer.ai/2024/02/02/cascade-inference.html", meta: { title: "FlashInfer: paged KV layout and cascade inference", desc: "Cascade inference with shared prefix KV-cache.", icon: fav("#e4572e", "F"), image: og("#e4572e", "#f2a541", "FI", 300, 300) } },
  /** 没有图 */
  noImage: { url: "https://github.com/GeeeekExplorer/nano-vllm", meta: { title: "nano-vllm: A lightweight vLLM implementation built from scratch", desc: "Fast offline inference in ~1,200 lines of readable Python, with prefix caching, tensor parallelism, CUDA graphs and torch compilation.", site: "GitHub", icon: fav("#24292f", "") } },
  /** 只有标题 */
  titleOnly: { url: "https://triton-lang.org/main/python-api/triton.language.html", meta: { title: "Triton Language Reference", icon: fav("#5b7bd5", "T") } },
  /** 什么都没抓到（要登录），网址很长 */
  failed: { url: "https://docs.internal.company/wiki/kv-cache-design/a-very-long-page-name-that-keeps-going-and-going?tab=notes&rev=2025-10-16T04:15:00Z&from=board", meta: { failed: true } },
  /** favicon 也坏了：域名首字母方块 */
  badIcon: { url: "https://pytorch.org/docs/stable/generated/torch.cuda.graphs.html", meta: { title: "CUDA Graphs — PyTorch documentation", desc: "Capture a sequence of kernels once and replay it with a single launch.", site: "PyTorch", icon: BROKEN } },
} satisfies Record<string, { url: string; meta: WebMeta }>;
export type PageKey = keyof typeof PAGES;
export const webCard = (id: string, page: PageKey | null, o: { style?: WebStyle; title?: string; desc?: string; url?: string } = {}): WebCard => {
  const p = page ? PAGES[page] : null;
  return { id, kind: "web", url: o.url ?? p?.url ?? "https://example.com/slow", ...(p ? { meta: { ...p.meta, at: 1 } } : {}), ...(o.style ? { style: o.style } : {}), ...(o.title ? { title: o.title } : {}), ...(o.desc ? { desc: o.desc } : {}) };
};
export const linksCard = (id: string, pages: PageKey[], o: { rich?: boolean; richRows?: number[]; title?: string } = {}): LinksCard => ({
  id, kind: "links", ...(o.rich ? { rich: true } : {}), ...(o.title ? { title: o.title } : {}),
  items: pages.map((k, i): LinkItem => ({ id: `${id}-i${i}`, url: PAGES[k].url, meta: { ...PAGES[k].meta, at: 1 }, ...(o.richRows?.includes(i) ? { rich: true } : {}) })),
});

// ---------- 子白板 ----------

/** 一块真的子白板（三张代码卡连成调用图、一张 Note、两个 Section），骨架用 core 的 skeletonOf 算：和宿主发来的一样 */
export function subBoard(id: string, name: string, o: { nested?: string; empty?: boolean } = {}): Board {
  const b = emptyBoard(id, name);
  if (o.empty) return b;
  const put = (c: Board["cards"][0], x: number, y: number, w: number, h?: number) => { b.cards.push(c); b.place[c.id] = { x, y, w, ...(h ? { h } : {}) }; };
  const s = codeCard(`${id}-s`, "schedule"), p = codeCard(`${id}-p`, "preempt"), a = codeCard(`${id}-a`, "canAppend");
  put(s, 40, 80, 520); put(p, 640, 80, 420); put(a, 640, 420, 420);
  put({ id: `${id}-n`, kind: "note", md: "## 抢占\n\nblock 不够就抢占最后进来的请求。", bg: true }, 40, 700, 360);
  if (o.nested) put({ id: `${id}-sub`, kind: "board", board: o.nested, title: "Block Manager" }, 460, 700, 420, 260);
  const line = (c: typeof s, word: string) => { const sg = c.segments[0]; return sg.start + Math.max(0, sg.text.findIndex((t) => t.includes(word))); };
  b.links.push(
    { id: `${id}-l1`, from: { card: s.id, seg: s.segments[0].id, line: line(s, "preempt(") }, to: { card: p.id }, call: { name: "preempt", col: 0 } },
    { id: `${id}-l2`, from: { card: s.id, seg: s.segments[0].id, line: line(s, "can_append") }, to: { card: a.id }, call: { name: "can_append", col: 0 } },
    { id: `${id}-l3`, from: { card: `${id}-n` }, to: { card: p.id } },
  );
  b.sections.push({ id: `${id}-sec1`, title: "Scheduler", x: 20, y: 30, w: 1080, h: 640, color: "blue" }, { id: `${id}-sec2`, title: "Notes", x: 20, y: 680, w: o.nested ? 880 : 400, h: 300, color: "sand" });
  return b;
}
export const skelOfBoard = (b: Board): Skeleton => ({ ...skeletonOf(b), commit: "f64d821" });
export const boardFrame = (id: string, board: string, title?: string): BoardCard => ({ id, kind: "board", board, ...(title ? { title } : {}) });

// ---------- play ----------

export async function waitFor<T>(get: () => T | null | undefined, what: string, ms = 8000): Promise<T> {
  const t0 = performance.now();
  for (;;) {
    const v = get();
    if (v) return v;
    if (performance.now() - t0 > ms) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((r) => requestAnimationFrame(r));
  }
}
export const $ = <E extends Element = HTMLElement>(sel: string) => document.querySelector<E>(sel);
/** 白板静下来：卡都量好、编辑器的挂载走完（两帧） */
export const frames = (n = 2) => new Promise<void>((r) => { const f = () => (--n <= 0 ? r() : requestAnimationFrame(f)); requestAnimationFrame(f); });
/** 真的指针事件（白板的手势认 pointerdown / up，不认合成的 click） */
export function pointer(el: Element, type: "pointerdown" | "pointerup" | "pointermove" | "pointerenter" | "pointerover", at?: { x: number; y: number }) {
  const r = el.getBoundingClientRect();
  const x = at?.x ?? r.left + r.width / 2, y = at?.y ?? r.top + r.height / 2;
  el.dispatchEvent(new PointerEvent(type, { bubbles: type !== "pointerenter", clientX: x, clientY: y, pointerId: 1, pointerType: "mouse", button: 0, buttons: type === "pointerup" ? 0 : 1, isPrimary: true }));
}
