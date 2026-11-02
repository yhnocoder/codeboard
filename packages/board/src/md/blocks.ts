// Note 拆成顶层块（箭头可以连到 Note 的某一块，core 的 End.block）：拆法和 @yhnocoder/markdown 的 mdBlockStarts 一样，
// 和静态显示、编辑器里的顶层元素一一对上。core 不解析 Markdown：块的原文由这里拆好，交给 core 撤销引擎的 upkeep（箭头端点跟着块走）
import { mdBlockStarts } from "@yhnocoder/markdown";

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
