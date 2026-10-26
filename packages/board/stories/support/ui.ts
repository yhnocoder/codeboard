// 界面外框（工具栏、菜单、对话框、⌘K、设置、导出、GitHub）的小样共用：play 里像用户一样点、右键、悬停，
// 宿主的回答按 story 换（support/host.ts 的表是固定的，这里在它前面再接一层）
import { onCleanup } from "solid-js";
import type { AskType, BoardToHost, Commit, GhFile, GhQuery, GhRepo, GhTree, SearchItem } from "@codeboard/core";
import { Stage, type Globals, type Scene } from "./board";
import { closeMenu } from "../../src/ui/Menu";
import { setPaletteOpen, setKeysOpen, setSettingsOpen } from "../../src/state/ui";
import { setGhPicker } from "../../src/state/web";
import { setExportBusy } from "../../src/state/export";
import { closeAllPops } from "../../src/state/pop";
import { setToastMsg } from "../../src/state/store";
import code from "../fixtures/code.json";

// ---------- 宿主的回答 ----------

/** 回答：返回值 = data；抛错 = 宿主报错（reply.error）；HANG = 一直不回（看「加载中」） */
export const HANG = Symbol("hang");
type Reply = (m: any) => unknown;
export type Replies = Partial<Record<AskType, Reply>>;
let replies: Replies = {};

const sent = window.__cbSent!;
const base = sent.push.bind(sent);
sent.push = (...ms: unknown[]) => {
  const rest: unknown[] = [];
  for (const m of ms) {
    const q = m as BoardToHost & { req?: number };
    const f = typeof q.req === "number" ? replies[q.type as AskType] : undefined;
    if (!f) { rest.push(m); continue; }
    Array.prototype.push.call(sent, m);
    const req = q.req;
    void (async () => {
      try {
        const data = await f(q);
        if (data !== HANG) window.postMessage({ type: "reply", req, data }, "*");
      } catch (e) { window.postMessage({ type: "reply", req, error: (e as Error).message }, "*"); }
    })();
  }
  return rest.length ? base(...rest) : sent.length;
};

// ---------- 舞台 ----------

/**
 * 白板的界面状态是整页一份：在 Storybook 里换 story 不重新载入页面，开着的设置页、⌘K、菜单、对话框会留到下一个 story。
 * 挂上和卸下时都关一遍（换白板的 init 只清它登记过的那些）
 */
function closeAll() {
  closeMenu(); setPaletteOpen(false); setKeysOpen(false); setSettingsOpen(false); setGhPicker(false); setExportBusy(false); closeAllPops(); setToastMsg(null);
  // 对话框没有导出关的办法：按 Esc（和用户一样），一层一层关
  for (let i = 0; i < 4 && document.querySelector(".dialog"); i++) window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
}

export function UiStage(p: { scene: () => Scene; globals: Globals; replies?: Replies }) {
  replies = p.replies ?? {};
  closeAll();
  onCleanup(() => { closeAll(); replies = {}; });
  return <Stage scene={p.scene} globals={p.globals} />;
}

// ---------- 像用户一样操作 ----------

export async function waitFor<T>(get: () => T | null | undefined | false, what = "the element", ms = 8000): Promise<T> {
  const t0 = performance.now();
  for (;;) {
    const v = get();
    if (v) return v;
    if (performance.now() - t0 > ms) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((r) => requestAnimationFrame(r));
  }
}
export const frames = (n = 2) => new Promise<void>((r) => { const k = () => (n-- <= 0 ? r() : requestAnimationFrame(k)); k(); });
export const el = <E extends Element = HTMLElement>(sel: string) => waitFor(() => document.querySelector<E>(sel), sel);
const resolve = (t: string | Element) => (typeof t === "string" ? el(t) : Promise.resolve(t));
const center = (e: Element) => { const r = e.getBoundingClientRect(); return { clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 }; };

/** 白板画好（卡挂上、量过尺寸）再操作：太早开的菜单会贴在还没摆好的元素上 */
export async function settled(sel = ".card") { await el(sel); await frames(4); }

/** 右键：坐标默认在元素中间（菜单从那里开） */
export async function rightClick(target: string | Element, at?: { x: number; y: number }) {
  const e = await resolve(target);
  const p = at ? { clientX: at.x, clientY: at.y } : center(e);
  e.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, button: 2, ...p }));
}
/** 右键一条线：落在路径的中点上 */
export async function rightClickLink(id: string) {
  const p = await el<SVGPathElement>(`path.lhit[data-link="${id}"]`);
  const m = p.getPointAtLength(p.getTotalLength() / 2), ctm = p.getScreenCTM()!;
  await rightClick(p, { x: ctm.a * m.x + ctm.c * m.y + ctm.e, y: ctm.b * m.x + ctm.d * m.y + ctm.f });
}
export async function click(target: string | Element) { (await resolve(target) as HTMLElement).click(); }
/** 悬停：提示 500ms 后出来 */
export async function hover(target: string | Element) {
  const e = await resolve(target);
  e.dispatchEvent(new PointerEvent("pointerover", { bubbles: true, ...center(e) }));
}
export async function key(k: string, o: KeyboardEventInit = {}) {
  (document.activeElement ?? window).dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true, ...o }));
  await frames(1);
}
/** 输入框里打字（走 Solid 的 onInput）；commit = 再发 change（设置页的数字框） */
export async function type(target: string | HTMLInputElement, text: string, o: { commit?: boolean } = {}) {
  const i = await resolve(target) as HTMLInputElement;
  i.focus();
  i.value = text;
  i.dispatchEvent(new InputEvent("input", { bubbles: true }));
  if (o.commit) i.dispatchEvent(new Event("change", { bubbles: true }));
  await frames(2);
}

/** 开着的第 level 级菜单（0 = 最外层），展开动画走完 */
export const menu = (level = 0) => waitFor(() => document.querySelectorAll<HTMLElement>(".ctx.open")[level], `menu level ${level}`);
/** 菜单里的一项：sub = 悬停打开它的二级菜单（和鼠标移上去一样），否则点它 */
export async function menuItem(label: string, o: { sub?: boolean; level?: number } = {}) {
  const m = await menu(o.level ?? 0);
  const b = await waitFor(() => [...m.querySelectorAll<HTMLButtonElement>("button[role=menuitem]")].find((x) => x.querySelector(".lb")?.textContent === label), `menu item ${label}`);
  if (o.sub) { b.dispatchEvent(new PointerEvent("pointerenter")); await menu((o.level ?? 0) + 1); }
  else b.click();
  return b;
}
/** 卡头的 ⋯（各种卡的 aria-label 不一样：Card / Note / Compare Menu） */
export async function cardMenu(id: string) {
  await settled();
  await click(`.card[data-id="${id}"] button[aria-label$="Menu"]`);
  return menu();
}
export const toolbar = (label: string) => click(`.bbar button[aria-label="${label}"]`);

// ---------- 假数据 ----------

export const SEARCH: SearchItem[] = [
  { kind: "entry", label: "nanovllm.LLM", detail: "nanovllm/__init__.py · __init__ export", path: "nanovllm/llm.py", line: 4, sym: "LLM" },
  { kind: "entry", label: "example.py", detail: "__main__", path: "example.py", line: 1 },
  { kind: "entry", label: "bench.py", detail: "examples", path: "bench.py", line: 1 },
  { kind: "symbol", label: "Scheduler.schedule", detail: "nanovllm/engine/scheduler.py:24", path: "nanovllm/engine/scheduler.py", line: 24, sym: "Scheduler.schedule", glyph: "ƒ" },
  { kind: "symbol", label: "Scheduler.preempt", detail: "nanovllm/engine/scheduler.py:60", path: "nanovllm/engine/scheduler.py", line: 60, sym: "Scheduler.preempt", glyph: "ƒ" },
  { kind: "symbol", label: "BlockManager", detail: "nanovllm/engine/block_manager.py:26", path: "nanovllm/engine/block_manager.py", line: 26, sym: "BlockManager", glyph: "C" },
  { kind: "symbol", label: "BlockManager.can_append", detail: "nanovllm/engine/block_manager.py:96", path: "nanovllm/engine/block_manager.py", line: 96, sym: "BlockManager.can_append", glyph: "ƒ" },
  { kind: "file", label: "scheduler.py", detail: "nanovllm/engine", path: "nanovllm/engine/scheduler.py" },
  { kind: "file", label: "block_manager.py", detail: "nanovllm/engine", path: "nanovllm/engine/block_manager.py" },
  { kind: "card", label: "Scheduler.schedule", detail: "KV cache 调度", board: "b-kv", card: "c1", num: "A1" },
  { kind: "card", label: "先 prefill 再 decode", detail: "Engine 总览", board: "b-engine", card: "n1" },
  { kind: "sidenote", label: "抢占时 block 全部释放", detail: "Scheduler.preempt · KV cache 调度", board: "b-kv", card: "c2", sidenote: "s1" },
];
export const ENTRIES = SEARCH.filter((s) => s.kind === "entry");

/** 按名字里有没有 q 筛（大小写不管）：像宿主一样，q 打得越多结果越少 */
export const searchReply = (items = SEARCH): Reply => (m: { q: string }) => {
  const q = m.q.toLowerCase();
  return items.filter((s) => s.kind !== "entry" && (s.label.toLowerCase().includes(q) || s.detail.toLowerCase().includes(q)));
};

export const REPO: GhRepo = {
  owner: "GeeeekExplorer", name: "nano-vllm", branch: "main", desc: "Nano vLLM",
  branches: ["main", "dev", "feat/chunked-prefill", "fix/preempt-order"], tags: ["v0.2.0", "v0.1.0"],
};
const SHA = "bb823b3e06983d71485a8e1f23715ebd87d98ef8";
export const COMMIT: Commit = { commit: SHA, msg: "Support chunked prefill", date: "2026-09-30" };
export const TREE: GhTree = {
  commit: SHA,
  paths: [
    { path: "nanovllm", dir: true }, { path: "nanovllm/engine", dir: true }, { path: "nanovllm/layers", dir: true }, { path: "nanovllm/models", dir: true },
    { path: "nanovllm/__init__.py" }, { path: "nanovllm/config.py" }, { path: "nanovllm/llm.py" }, { path: "nanovllm/sampling_params.py" },
    { path: "nanovllm/engine/block_manager.py" }, { path: "nanovllm/engine/llm_engine.py" }, { path: "nanovllm/engine/model_runner.py" },
    { path: "nanovllm/engine/scheduler.py" }, { path: "nanovllm/engine/sequence.py" },
    { path: "nanovllm/layers/attention.py" }, { path: "nanovllm/layers/sampler.py" }, { path: "nanovllm/models/qwen3.py" },
    { path: "README.md" }, { path: "bench.py" }, { path: "example.py" }, { path: "pyproject.toml" },
  ],
};
// 文件内容借 Scheduler.schedule 的夹具（已经高亮好），行号从 1 数
export const FILE: GhFile = { path: "nanovllm/engine/scheduler.py", lang: "python", text: code.schedule.seg.text, html: code.schedule.view.html };

/** GitHub 面板的回答：按 op 分；fail = 那一步报的错，hang = 那一步一直不回（看加载中） */
export function github(o: { repo?: Partial<GhRepo>; fail?: { op: GhQuery["op"]; error: string }; hang?: GhQuery["op"]; truncated?: boolean } = {}): Reply {
  return (m: { q: GhQuery }) => {
    const q = m.q;
    if (o.hang === q.op) return HANG;
    if (o.fail?.op === q.op) throw new Error(o.fail.error);
    switch (q.op) {
      case "repo": return { ...REPO, owner: q.owner, name: q.name, ...o.repo };
      case "commit": return { ...COMMIT, commit: /^[0-9a-f]{7,40}$/i.test(q.ref) ? q.ref.padEnd(40, "0") : SHA };
      case "tree": return { ...TREE, truncated: o.truncated };
      case "file": return { ...FILE, path: q.path };
      default: return HANG;
    }
  };
}
