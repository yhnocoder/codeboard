// Note 拆成顶层块（箭头可以连到 Note 的某一块，core 的 End.block）：拆法和 @yhnocoder/markdown 的 mdBlockStarts 一样，
// 和静态显示、编辑器里的顶层元素一一对上。core 不解析 Markdown：块的原文由这里拆好交给 core 的 rebaseBlocks
import { mdBlockStarts } from "@yhnocoder/markdown";
import { rebaseBlocks, type Board } from "@codeboard/core";

const cache = new Map<string, string[] | null>();
/** 每一块的 Markdown 原文；拆不开（有脚注、\r）时 null */
export function noteBlocks(md: string): string[] | null {
  let v = cache.get(md);
  if (v !== undefined) return v;
  const st = mdBlockStarts(md);
  v = st ? st.map((s, i) => md.slice(s, st[i + 1] ?? md.length).trim()) : null;
  if (cache.size >= 400) cache.delete(cache.keys().next().value!);
  cache.set(md, v);
  return v;
}

/**
 * 每次改完白板（store 的 mutate / sync / live 里，和 syncTwins 一样）：md 变了的 Note 上连着块的箭头端点跟着块走。
 * seen = 上次看到的每张 Note 的 md；白板上没有连着块的箭头时不记（什么都不用跟）。
 * 这次新出现的 Note（Split by Headings 拆出来的）交给 rebaseBlocks：删掉的块原样到了那里，端点跟过去。raw：store 里读普通对象
 */
export function followBlocks(b: Board, seen: Map<string, string>, raw: <T>(x: T) => T): void {
  const rb = raw(b);
  const on = new Set<string>();
  for (const l of rb.links) {
    if (l.from.block) on.add(l.from.card);
    if (l.to.block) on.add(l.to.card);
  }
  if (!on.size) {
    seen.clear();
    return;
  }
  const first = !seen.size,
    now = new Map<string, string>(),
    fresh: { card: string; blocks: string[] }[] = [],
    changed: [string, string, string][] = [];
  for (const c of rb.cards) {
    if (c.kind !== "note") continue;
    now.set(c.id, c.md);
    const was = seen.get(c.id);
    if (was === undefined) {
      if (!first)
        fresh.push({
          card: c.id,
          get blocks() {
            return noteBlocks(c.md) ?? [];
          },
        });
    } else if (was !== c.md && on.has(c.id)) changed.push([c.id, was, c.md]);
  }
  for (const [id, was, md] of changed) rebaseBlocks(b, id, noteBlocks(was), noteBlocks(md), fresh);
  seen.clear();
  for (const [k, v] of now) seen.set(k, v);
}
