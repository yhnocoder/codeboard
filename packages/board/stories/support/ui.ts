// 界面外框（工具栏、菜单、对话框、⌘K、设置、导出、GitHub）的小样共用：开菜单、点菜单项，
// 和按 story 换的宿主回答（交给 Stage 的 replies）用的假数据
import type { Commit, GhFile, GhQuery, GhRepo, GhTree, SearchItem } from "@codeboard/core";
import { HANG, type Reply } from "./host";
import { waitFor, settled, click } from "./play";
import code from "../fixtures/code.json";

/** 开着的第 level 级菜单（0 = 最外层），展开动画走完 */
export const menu = (level = 0) =>
  waitFor(() => document.querySelectorAll<HTMLElement>(".ctx.open")[level], `menu level ${level}`);
/** 菜单里名字是 label 的那一项（不动它） */
export async function menuButton(label: string, level = 0) {
  const m = await menu(level);
  return waitFor(
    () =>
      [...m.querySelectorAll<HTMLButtonElement>("button[role=menuitem]")].find(
        (x) => x.querySelector(".lb")?.textContent === label,
      ),
    `menu item ${label}`,
  );
}
/** 菜单里的一项：sub = 悬停打开它的二级菜单（和鼠标移上去一样），否则点它 */
export async function menuItem(label: string, o: { sub?: boolean; level?: number } = {}) {
  const b = await menuButton(label, o.level ?? 0);
  if (o.sub) {
    b.dispatchEvent(new PointerEvent("pointerenter"));
    await menu((o.level ?? 0) + 1);
  } else b.click();
  return b;
}
/** 卡头的 ⋯（各种卡的 aria-label 不一样：Card / Note / Compare Menu） */
export async function cardMenu(id: string) {
  await settled();
  await click(`.card[data-id="${id}"] button[aria-label$="Menu"]`);
  return menu();
}
export const toolbar = (label: string) => click(`.bbar button[aria-label="${label}"]`);

export const SEARCH: SearchItem[] = [
  {
    kind: "entry",
    label: "nanovllm.LLM",
    detail: "nanovllm/__init__.py · __init__ export",
    path: "nanovllm/llm.py",
    line: 4,
    sym: "LLM",
  },
  { kind: "entry", label: "example.py", detail: "__main__", path: "example.py", line: 1 },
  { kind: "entry", label: "bench.py", detail: "examples", path: "bench.py", line: 1 },
  {
    kind: "symbol",
    label: "Scheduler.schedule",
    detail: "nanovllm/engine/scheduler.py:24",
    path: "nanovllm/engine/scheduler.py",
    line: 24,
    sym: "Scheduler.schedule",
    glyph: "ƒ",
  },
  {
    kind: "symbol",
    label: "Scheduler.preempt",
    detail: "nanovllm/engine/scheduler.py:60",
    path: "nanovllm/engine/scheduler.py",
    line: 60,
    sym: "Scheduler.preempt",
    glyph: "ƒ",
  },
  {
    kind: "symbol",
    label: "BlockManager",
    detail: "nanovllm/engine/block_manager.py:26",
    path: "nanovllm/engine/block_manager.py",
    line: 26,
    sym: "BlockManager",
    glyph: "C",
  },
  {
    kind: "symbol",
    label: "BlockManager.can_append",
    detail: "nanovllm/engine/block_manager.py:96",
    path: "nanovllm/engine/block_manager.py",
    line: 96,
    sym: "BlockManager.can_append",
    glyph: "ƒ",
  },
  { kind: "file", label: "scheduler.py", detail: "nanovllm/engine", path: "nanovllm/engine/scheduler.py" },
  { kind: "file", label: "block_manager.py", detail: "nanovllm/engine", path: "nanovllm/engine/block_manager.py" },
  { kind: "card", label: "Scheduler.schedule", detail: "KV cache 调度", board: "b-kv", card: "c1", num: "A1" },
  { kind: "card", label: "先 prefill 再 decode", detail: "Engine 总览", board: "b-engine", card: "n1" },
  {
    kind: "sidenote",
    label: "抢占时 block 全部释放",
    detail: "Scheduler.preempt · KV cache 调度",
    board: "b-kv",
    card: "c2",
    sidenote: "s1",
  },
];
export const ENTRIES = SEARCH.filter((s) => s.kind === "entry");

/** 按名字里有没有 q 筛（大小写不管）：像宿主一样，q 打得越多结果越少 */
export const searchReply =
  (items = SEARCH): Reply =>
  (m: { q: string }) => {
    const q = m.q.toLowerCase();
    return items.filter(
      (s) => s.kind !== "entry" && (s.label.toLowerCase().includes(q) || s.detail.toLowerCase().includes(q)),
    );
  };

export const REPO: GhRepo = {
  owner: "GeeeekExplorer",
  name: "nano-vllm",
  branch: "main",
  desc: "Nano vLLM",
  branches: ["main", "dev", "feat/chunked-prefill", "fix/preempt-order"],
  tags: ["v0.2.0", "v0.1.0"],
};
const SHA = "bb823b3e06983d71485a8e1f23715ebd87d98ef8";
export const COMMIT: Commit = { commit: SHA, msg: "Support chunked prefill", date: "2026-09-30" };
export const TREE: GhTree = {
  commit: SHA,
  paths: [
    { path: "nanovllm", dir: true },
    { path: "nanovllm/engine", dir: true },
    { path: "nanovllm/layers", dir: true },
    { path: "nanovllm/models", dir: true },
    { path: "nanovllm/__init__.py" },
    { path: "nanovllm/config.py" },
    { path: "nanovllm/llm.py" },
    { path: "nanovllm/sampling_params.py" },
    { path: "nanovllm/engine/block_manager.py" },
    { path: "nanovllm/engine/llm_engine.py" },
    { path: "nanovllm/engine/model_runner.py" },
    { path: "nanovllm/engine/scheduler.py" },
    { path: "nanovllm/engine/sequence.py" },
    { path: "nanovllm/layers/attention.py" },
    { path: "nanovllm/layers/sampler.py" },
    { path: "nanovllm/models/qwen3.py" },
    { path: "README.md" },
    { path: "bench.py" },
    { path: "example.py" },
    { path: "pyproject.toml" },
  ],
};
// 文件内容借 Scheduler.schedule 的夹具（已经高亮好），行号从 1 数
export const FILE: GhFile = {
  path: "nanovllm/engine/scheduler.py",
  lang: "python",
  text: code.schedule.seg.text,
  html: code.schedule.view.html,
};

/** GitHub 面板的回答：按 op 分；fail = 那一步报的错，hang = 那一步一直不回（看加载中） */
export function github(
  o: {
    repo?: Partial<GhRepo>;
    fail?: { op: GhQuery["op"]; error: string };
    hang?: GhQuery["op"];
    truncated?: boolean;
  } = {},
): Reply {
  return (m: { q: GhQuery }) => {
    const q = m.q;
    if (o.hang === q.op) return HANG;
    if (o.fail?.op === q.op) throw new Error(o.fail.error);
    switch (q.op) {
      case "repo":
        return { ...REPO, owner: q.owner, name: q.name, ...o.repo };
      case "commit":
        return { ...COMMIT, commit: /^[0-9a-f]{7,40}$/i.test(q.ref) ? q.ref.padEnd(40, "0") : SHA };
      case "tree":
        return { ...TREE, truncated: o.truncated };
      case "file":
        return { ...FILE, path: q.path };
      default:
        return HANG;
    }
  };
}
