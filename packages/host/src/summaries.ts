// Zoomed-out AI summaries (#130; the rules are in core's summary.ts). DeepSeek writes them (the key stays in the host, like the
// other AI tools): at once for ↻ (the board's "summarize", one item, the only way to force a rewrite), and by itself for an open
// board, one item at a time: a pending item (its Section's card count or a card title changed, or no summary yet) after
// SUMMARY.regenMs without another change, and on opening a board only the written items whose cards changed since. Each summary
// keeps the hash of the inputs it was written from (summaryInput: card ids, titles and contents), and no request is sent while
// that hash is unchanged (an undo, a change and its reverse, a reload). The waiting is per host session. A summary the user
// edited is rewritten like the others, in the style of the edit (its pairs go with the request), and the user's latest edited
// Sections on any board are the prompt's examples. Without a key nothing is written; the board shows the title with an empty body.
import {
  SUMMARY,
  estSize,
  layoutSummaries,
  readSummaryReply,
  sectionFrames,
  summaryOf,
  summaryPending,
  summaryRequest,
  summarySources,
  summarySig,
  summaryInput,
  unsummarized,
  summaryExamples,
  type Board,
  type Disposable,
  type HostToBoard,
  type Rect,
  type SumKey,
  type SumRequest,
  type SummaryResult,
} from "@codeboard/core";
import { deepseekKey, deepseekTarget } from "./ai";
import { DEEPSEEK_MODEL, type DeepseekRequest } from "./deepseek";
import type { HostContext } from "./context";

/**
 * THE summary prompt (feedback/demo/130-deepseek-prompt.md, "最终提示词", verbatim): the system text and the user template with
 * its few-shot examples, and SUMMARY_PAIRS_INTRO / SUMMARY_PAIR for a summary the user edited. {…} are filled from the request, and the user's own
 * edited summaries take the examples' places (summaryPrompt). Swap a retuned version in here; nothing else holds prompt text
 */
export const SUMMARY_SYSTEM = `你为白板缩远视图写 Section 摘要。缩远时读者只扫一眼，所以摘要必须先让人抓住重点。只输出摘要正文本身，不要标题、不要引号、不要解释。`;
const SUMMARY_USER = `下面是 4 个好摘要的例子（先是 Section 内容的浓缩，再是理想摘要），学它们的写法：先点出核心观点，细节舍得删；每个要点一句，要点多少决定写多长。

例 1
标题：使用 Kogge–Stone 算法进行 parallel scan
内容：逐个输出各做一棵 reduction：所有输出可同时算，但最后一个仍要 N 步，工作量 O(N²)。更好的办法是让不同 reduction tree 共享部分和：Kogge–Stone 原为高速加法器提出，原地 scan，每轮步长 1、2、4、8 翻倍，每个位置加上左侧相隔一个步长的值，k 轮后保存最多 2^k 个输入的和。
摘要：让各输出的 reduction tree **共享部分和**，log N 轮就能算完 scan。每轮**步长翻倍**，每个位置加上左边相隔一个步长的值。逐输出各算一遍则要 O(N²) 的功，**跨度也没降**。

例 2
标题：并行 radix sort
内容：每次迭代依赖上一次的完整结果，所以迭代间串行，并行只在迭代内部。让每个线程负责一个键，取出当前位，0 的目标下标 = 键下标 − 此前 1 的个数，此前 1 的个数用 exclusive scan 求。kernel 代码：取 bit、gridExclusiveScan、算 dst、写出。
摘要：radix sort 的并行只能在每次**迭代内部**，迭代之间必须串行。做法是**一个线程管一个键**，靠 exclusive scan 数出它前面有多少个 1，由此算出它在**输出里的位置**。

例 3
标题：用 warp 级原语对原子操作做 coalescing
内容：简单 filter kernel 中各线程争用同一个输出计数器，同一 warp 的原子操作必然被硬件串行化。让 warp 协作：指定 leader，算出总增量，由 leader 做一次原子操作并广播起始位置，各线程算偏移。用 __activemask、__ffs、__popc、__shfl_sync，或 cooperative groups 的 coalesced_threads。代码两份。
摘要：同一 warp 的原子操作**必然串行**，所以让一个 leader **代表整个 warp** 只发一次原子操作。leader 数出要保留的键，把计数器加上这个总数，再把拿到的起点**广播**给其他线程，各自按序号写出。

例 4
标题：Floyd-Warshall 算法
内容：d(i,j,k) 表示只允许顶点 0..k 作中间点的最短距离，递推 min(d(i,j,k-1), d(i,k,k-1)+d(k,j,k-1))。自底向上从小 k 开始；k 的访问次序不重要；只需保存 O(N²) 而非 O(N³)。三层循环，内两层并行，同一 k 的所有单元算完才能进下一个 k。CUDA kernel 每个线程算一格，用 shared 缓存 dist[i][k]。
摘要：每个中间顶点 k 都要把整张距离表更新一遍，而同一个 k 内**各单元互不依赖**，所以**一个线程算一格**；不同 k 之间要**全局同步**，每个 k 启动一次 kernel。

---

Section 标题：{标题}

这个 Section 里的卡片：
{卡片内容，笔记卡去掉图片和标签，代码卡前 80 行，共最多 6000 字}

写法：
1. 第一句只说这个 Section 的核心观点：读者读完只记住一件事的话，该记住什么。用判断或结论的口吻，说“为什么／怎么做才成立”，不要罗列“介绍了……、包括……”。
2. 后面的句子按重要性支撑第一句：先是最关键的原因或做法，再是次要的补充。越往后越可以删。
3. 数字、API 名、例子，只在它们本身就是重点时才写；细节、公式推导、参数、代码里的变量名一律省略。
4. 加粗（用 **…** 包起来）每个重要句子的关键短语：大约每 40 字一处，最多 3 处；不到 50 字的摘要正好一处。每处 2–10 个字；加粗的字合起来不超过全文的四分之一。第一处加粗放在核心观点上。不要加粗数字或 API 名。
5. 不要重复标题；用中文；英文术语可以保留。

长度：跟着卡片内容有多少要点走，和摆放的地方无关。卡片里每个独立的关键要点写一句：内容单薄的 Section 一句就够，内容丰富的最多六句左右。绝不凑字数，也不要硬塞细节；一般不超过 250 字。
只输出摘要正文。
`;

/** Added for a summary the user edited (SumRequest.pairs, newest first), before the last line: the intro, then one block a pair */
const SUMMARY_PAIRS_INTRO = `这个 Section 的摘要用户改过（从新到旧）。照用户的改法写：保留他的强调、措辞和长度偏好，只按卡片现在的内容更新；几次改法冲突的地方以较新的为准，一致的偏好都保留。`;
const SUMMARY_PAIR = `第 {序号} 次（{新旧}）AI 原来写的：
{AI 原文}
用户改成：
{用户改的}`;

/** How many examples the prompt shows */
const SUMMARY_EXAMPLES = 4;
const EXAMPLE = /例 (\d+)\n标题：(.*)\n内容：(.*)\n摘要：(.*)/g;
/** The prompt's own examples, in its order */
const BUILT_IN = [...SUMMARY_USER.matchAll(EXAMPLE)].map((m) => ({ title: m[2], content: m[3], summary: m[4] }));

/**
 * The prompt for one request: the Section's (or card's) title and its cards (no layout numbers: the length follows the content); the user's
 * edited summaries (r.examples, most recent first) in the examples' first places, the prompt's own in the rest; and the user's
 * edits of this one (r.pairs, newest first)
 */
export function summaryPrompt(r: SumRequest): { system: string; user: string } {
  const cards = r.cards.map((c) => `【${c.title}】\n${c.text.trim()}`).join("\n\n");
  const fill = (t: string, f: Record<string, string>) => t.replace(/\{([^{}]+)\}/g, (m, k: string) => f[k] ?? m);
  const examples = [...(r.examples ?? []), ...BUILT_IN]
    .slice(0, SUMMARY_EXAMPLES)
    .map((e, i) => `例 ${i + 1}\n标题：${e.title}\n内容：${e.content}\n摘要：${e.summary}`)
    .join("\n\n");
  const first = SUMMARY_USER.indexOf("例 1\n"),
    rest = SUMMARY_USER.indexOf("\n\n---\n");
  let user = SUMMARY_USER.slice(0, first) + examples + SUMMARY_USER.slice(rest);
  user = fill(user, {
    标题: r.title,
    "卡片内容，笔记卡去掉图片和标签，代码卡前 80 行，共最多 6000 字": cards,
  });
  if (r.pairs?.length) {
    const n = r.pairs.length;
    const pairs = r.pairs.map((p, i) =>
      fill(SUMMARY_PAIR, {
        序号: String(i + 1),
        新旧: i === 0 ? "最新" : i === n - 1 ? "最旧" : "较旧",
        "AI 原文": p.ai,
        用户改的: p.user,
      }),
    );
    const last = user.lastIndexOf("只输出摘要正文。");
    user = `${user.slice(0, last)}${[SUMMARY_PAIRS_INTRO, ...pairs].join("\n\n")}\n${user.slice(last)}`;
  }
  return { system: SUMMARY_SYSTEM, user };
}

/** How long one summary may take */
const SUMMARY_TIMEOUT = 60_000;

export function summaryChatRequest(
  o: { key: string; baseUrl?: string; model?: string },
  r: SumRequest,
): DeepseekRequest {
  const p = summaryPrompt(r);
  return {
    url: `${(o.baseUrl || "https://api.deepseek.com").replace(/\/+$/, "")}/chat/completions`,
    init: {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json", Authorization: `Bearer ${o.key}` },
      body: JSON.stringify({
        model: o.model || DEEPSEEK_MODEL,
        max_tokens: 800,
        temperature: 0.2,
        stream: false,
        thinking: { type: "disabled" },
        messages: [
          { role: "system", content: p.system },
          { role: "user", content: p.user },
        ],
      }),
    },
  };
}

/** Ask DeepSeek for one summary. Never throws: failures come back as { fail } (no key: nokey) */
export async function summarize(cx: HostContext, r: SumRequest, f: typeof fetch = fetch): Promise<SummaryResult> {
  const key = await deepseekKey(cx);
  if (!key) return { fail: "nokey", via: "DeepSeek" };
  const ac = new AbortController();
  let timedOut = false;
  const t = setTimeout(() => {
    timedOut = true;
    ac.abort();
  }, SUMMARY_TIMEOUT);
  try {
    const q = summaryChatRequest({ key, ...deepseekTarget(cx) }, r);
    const res = await f(q.url, { ...q.init, signal: ac.signal });
    const json = (await res.json().catch(() => undefined)) as
      | { error?: { message?: string }; choices?: { message?: { content?: string } }[] }
      | undefined;
    if (res.status === 401) return { fail: "badkey", message: json?.error?.message, via: "DeepSeek" };
    if (res.status === 402) return { fail: "balance", message: json?.error?.message, via: "DeepSeek" };
    if (!res.ok) return { fail: "http", message: json?.error?.message || `HTTP ${res.status}`, via: "DeepSeek" };
    const s = readSummaryReply(json?.choices?.[0]?.message?.content ?? "", r, Date.now());
    return s ? { summary: s } : { fail: "http", message: "DeepSeek returned an empty answer", via: "DeepSeek" };
  } catch (e) {
    return timedOut
      ? { fail: "timeout", message: `No answer within ${SUMMARY_TIMEOUT / 1000} s`, via: "DeepSeek" }
      : { fail: "network", message: (e as Error)?.message || String(e), via: "DeepSeek" };
  } finally {
    clearTimeout(t);
  }
}

/** Every item's request on a board the host has no measurements for: card heights as stored (Place.h / mh) or estimated */
export function hostRequests(b: Board): Map<SumKey, SumRequest> {
  const rects = new Map<string, Rect>();
  for (const c of b.cards) {
    const p = b.place[c.id];
    if (p) rects.set(c.id, { x: p.x, y: p.y, ...estSize(c, p) });
  }
  const layout = layoutSummaries(summarySources(b, (id) => rects.get(id), sectionFrames(b, rects)));
  const out = new Map<SumKey, SumRequest>();
  for (const c of layout.cols) {
    const r = summaryRequest(b, c.key, layout);
    if (r) out.set(c.key, r);
  }
  return out;
}

/** What the watcher needs of the hub: a board as stored, and posting to its panel (false: not open now) */
export type SummaryHub = {
  board(id: string): Board | undefined;
  /** Every board the host has read (where the user's edited summaries are found) */
  boards(): Board[];
  post(id: string, m: HostToBoard): boolean;
};
/** The request with the user's edited summaries on these boards as its examples (not the item's own) */
export const withExamples = (r: SumRequest, boards: Board[], board: string): SumRequest => {
  const examples = summaryExamples(boards, SUMMARY_EXAMPLES, { board, key: r.key });
  return examples.length ? { ...r, examples } : r;
};

/**
 * The host writing summaries by itself. saw() after every save of a board: an item whose sig changed (a Section's card count or
 * card titles, a card's title) waits SUMMARY.regenMs from its latest change; opened() when a board shows: items with no summary
 * are written at once, pending ones wait the full time. One request at a time; results go to the board's panel, which saves
 * them like any other change (and a closed board keeps its item pending for next time)
 */
export class SummaryWatch implements Disposable {
  private timers = new Map<string, ReturnType<typeof setTimeout>>();
  /** board id → item key → the sig last seen (a save with the same sig does not restart the wait) */
  private seen = new Map<string, Map<string, string>>();
  private queue: Promise<unknown> = Promise.resolve();
  private gone = false;

  constructor(
    private cx: HostContext,
    private hub: SummaryHub,
    private send?: typeof globalThis.fetch,
  ) {}

  opened(b: Board) {
    this.seen.delete(b.id);
    this.look(b, true);
  }
  saw(b: Board) {
    if (this.seen.has(b.id)) this.look(b, false);
  }
  /** The board's items whose wait is running */
  waiting(id: string): string[] {
    return [...this.timers.keys()].filter((k) => k.startsWith(`${id}\n`)).map((k) => k.slice(id.length + 1));
  }

  private look(b: Board, first: boolean) {
    let seen = this.seen.get(b.id);
    if (!seen) this.seen.set(b.id, (seen = new Map()));
    const keys = new Set<string>();
    for (const s of b.sections) if (!s.parent) keys.add(`sec:${s.id}`);
    for (const c of b.cards) if (b.place[c.id] && !b.place[c.id].section && !unsummarized(c)) keys.add(`card:${c.id}`);
    for (const t of this.waiting(b.id)) if (!keys.has(t)) this.stop(b.id, t);
    for (const key of keys) {
      const sig = summarySig(b, key);
      if (sig === undefined) continue;
      const was = seen.get(key);
      seen.set(key, sig);
      if (!summaryPending(b, key)) {
        this.stop(b.id, key);
        continue;
      }
      // opening a board asks only for summaries whose cards changed since they were written; a missing one waits for a change
      // in this session (or ↻): never the whole board at once
      const s = summaryOf(b, key);
      if (first ? !!s && !!s.input && s.input !== summaryInput(b, key) : was !== sig) this.wait(b.id, key);
    }
  }
  private stop(id: string, key: string) {
    const k = `${id}\n${key}`;
    clearTimeout(this.timers.get(k));
    this.timers.delete(k);
  }
  private wait(id: string, key: string) {
    this.stop(id, key);
    const k = `${id}\n${key}`;
    this.timers.set(
      k,
      setTimeout(() => {
        this.timers.delete(k);
        this.write(id, key);
      }, SUMMARY.regenMs),
    );
  }
  /** Write one item's summary if it is still pending (in the style of the user's edits, if any) */
  private write(id: string, key: string) {
    this.queue = this.queue.then(async () => {
      const b = this.hub.board(id);
      if (this.gone || !b || !summaryPending(b, key)) return;
      // the same cards, titles and contents it was written from (an undo, a change and its reverse): nothing to ask
      const was = summaryOf(b, key)?.input;
      if (was && was === summaryInput(b, key)) return;
      const r0 = hostRequests(b).get(key as SumKey);
      if (!r0) return;
      const req = withExamples(r0, this.hub.boards(), id);
      const r = await summarize(this.cx, req, this.send);
      if (this.gone) return;
      if ("fail" in r) {
        if (r.fail !== "nokey") this.cx.log("warn", `summary ${key}: ${r.fail}${r.message ? `: ${r.message}` : ""}`);
        return;
      }
      this.hub.post(id, { type: "summaries", items: { [key]: r.summary } });
    });
  }
  /** Settled when the requests queued so far are done (tests) */
  idle(): Promise<unknown> {
    return this.queue;
  }

  dispose() {
    this.gone = true;
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
  }
}
