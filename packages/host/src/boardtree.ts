// 一块白板可以在几块父白板下面各出现一次；有父白板的不再列在顶层（只在环里的除外，免得从侧栏消失）。
import type { BoardMeta } from "@codeboard/core";

/** path = 从顶层到它的白板 id（树里同一块白板可以出现几次，节点 id 要按路径区分；也防环） */
export type TreeNode = { kind: "group"; name: string } | { kind: "board"; id: string; meta: BoardMeta; path: string[] };

export function treeChildren(metas: BoardMeta[], groups: string[], n?: TreeNode): TreeNode[] {
  const byId = new Map(metas.map((m) => [m.id, m]));
  const board = (meta: BoardMeta, path: string[] = []): TreeNode => ({ kind: "board", id: meta.id, meta, path: [...path, meta.id] });
  const nested = new Set(metas.flatMap((m) => (m.subs ?? []).filter((id) => id !== m.id)));
  const top = (m: BoardMeta) => !nested.has(m.id) || isolated(m.id, byId);
  if (!n) return [...groups.map((name): TreeNode => ({ kind: "group", name })), ...metas.filter((m) => !m.group && top(m)).map((m) => board(m))];
  if (n.kind === "group") return metas.filter((m) => m.group === n.name && top(m)).map((m) => board(m));
  return (n.meta.subs ?? []).filter((id) => !n.path.includes(id)).map((id) => byId.get(id)).filter((m): m is BoardMeta => !!m).map((m) => board(m, n.path));
}

/** 只在环里出现的白板（文件被手改过才会有环）：没有不在环里的父白板，放回顶层，免得从侧栏消失 */
function isolated(id: string, byId: Map<string, BoardMeta>): boolean {
  const parents = [...byId.values()].filter((m) => m.subs?.includes(id) && m.id !== id);
  const seen = new Set<string>([id]);
  const stack = parents.map((m) => m.id);
  while (stack.length) {
    const x = stack.pop()!;
    if (seen.has(x)) continue;
    seen.add(x);
    const up = [...byId.values()].filter((m) => m.subs?.includes(x));
    if (!up.length) return false; // 走到了一块顶层白板
    stack.push(...up.map((m) => m.id));
  }
  return true;
}

