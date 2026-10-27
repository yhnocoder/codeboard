// 没有 VS Code 时 src/host.ts 把消息 push 进 window.__cbSent：先放一个改了 push 的数组，就能不改 host.ts 当宿主回 ask。
// 只有这一个假宿主：回答是一条链，先问挂着的 story 自己的（Stage 的 replies、usePacks，卸下就撤掉），
// 再问各块小样登记的（reply()，按段 id、按词各管各的，互不重叠），最后是这里的默认回答。
// 哪一层返回 PASS 就问下一层；所以回答不看之前点过哪些 story、加载过哪些模块
import { onCleanup } from "solid-js";
import type { AskType, BoardToHost, Commit, SegView } from "@codeboard/core";
import code from "../fixtures/code.json";
import NOTE_HTML from "../fixtures/notecode.json";
import { noteCodeKey } from "../fixtures/notecode";

export const VIEWS: Record<string, SegView> = Object.fromEntries(Object.values(code).map((x) => [x.seg.id, x.view as SegView]));

/** 这一层不管，问下一层 */
export const PASS = Symbol("pass");
/** 一直不回（看「加载中」） */
export const HANG = Symbol("hang");
/** 回答：返回值（可以是 Promise）= data；抛错 = 宿主报错（reply.error）；PASS、HANG 见上 */
export type Reply = (m: any) => unknown;
export type Replies = Partial<Record<AskType, Reply>>;

// 假仓库的提交（版本面板、Pick a Commit）
export const COMMITS: Commit[] = [
  { commit: "f64d8217aa03", msg: "scheduler: chunked prefill only for the first seq", date: "2026-10-21", head: true },
  { commit: "bb823b3c0ffe", msg: "block manager: hash the last full block", date: "2026-09-30" },
  { commit: "4c1d0e9aa5b1", msg: "preempt: put the request back at the front", date: "2026-09-12" },
  { commit: "9f3e2a1c7d42", msg: "first version of the scheduler", date: "2026-08-02" },
];

// 没有仓库、不存盘：回空的，白板照常走下去
const DEFAULTS: Replies = {
  patch: () => ({ skipped: 0 }),
  views: (m: Extract<BoardToHost, { type: "views" }>) => Object.fromEntries(m.segs.flatMap((s) => {
    if (VIEWS[s.id]) return [[s.id, VIEWS[s.id]]];
    // Note 代码块的着色：宿主用 shiki 做，这里查 gen.ts 预先算好的表（按「语言 + 代码」）
    const html = (NOTE_HTML as Record<string, string[]>)[noteCodeKey(s.lang, s.text.join("\n"))];
    return html ? [[s.id, { html, flags: html.map(() => 0), calls: [], defs: [], bare: {} }]] : [];
  })),
  skeletons: () => ({}),
  permalinks: () => ({}),
  stickerPacks: () => [],
  questions: () => [],
  search: () => [],
  entryPoints: () => [],
  searchName: () => [],
  commits: () => COMMITS,
  variantSources: () => ({
    worktrees: [{ dir: "/work/vllm-exp", branch: "exp-overlap", label: "../vllm-exp · exp-overlap" }, { dir: "/work/nano-vllm-spec", branch: "fix-spec-bug", label: "../nano-vllm-spec · fix-spec-bug", dirty: true }],
    branches: ["main", "fix-spec-bug", "exp-overlap", "chunked-prefill-v2"], current: "main", pr: "GeeeekExplorer/nano-vllm",
  }),
  callVars: () => [],
  lspComplete: () => [],
  lspHover: () => [],
  confirm: () => false,
};

const area: Partial<Record<AskType, Reply[]>> = {};
const scoped: Replies[] = [];

/** 各块小样在模块里登记（一直有效）：只答自己认得的（自己的段 id、词），别的返回 PASS */
export function reply(type: AskType, f: Reply) { (area[type] ??= []).push(f); }

/** story 挂着时才有效的回答，比 reply() 和默认的先问；返回撤掉的函数 */
export function addReplies(r: Replies): () => void {
  scoped.unshift(r);
  return () => { const i = scoped.indexOf(r); if (i >= 0) scoped.splice(i, 1); };
}
/** 在组件里：卸下时撤掉 */
export function useReplies(r: Replies) { onCleanup(addReplies(r)); }

function answer(q: { type: AskType }): unknown {
  for (const f of [...scoped.map((r) => r[q.type]), ...(area[q.type] ?? []), DEFAULTS[q.type]]) {
    if (!f) continue;
    const v = f(q);
    if (v !== PASS) return v;
  }
  return null;
}

const sent: unknown[] = [];
sent.push = (...ms: unknown[]) => {
  for (const m of ms) {
    const q = m as BoardToHost & { req?: number };
    if (typeof q.req !== "number") continue;
    const req = q.req;
    void (async () => {
      try {
        const data = await answer(q as { type: AskType });
        if (data !== HANG) window.postMessage({ type: "reply", req, data: data ?? null }, "*");
      } catch (e) { window.postMessage({ type: "reply", req, error: (e as Error).message }, "*"); }
    })();
  }
  return Array.prototype.push.apply(sent, ms);
};
window.__cbSent = sent;
