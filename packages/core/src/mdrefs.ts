// Note 里的 [[引用]]：[[标题]]，或者从 [[ 列表选的 [[标题#^id]]（id 是目标的 id，跨白板的是 白板id/卡id）。
// 写法由 @yhnocoder/markdown 定（schema-nodes.ts WikiRef，那边有为什么是 #^）；core 不引入那个包（它带着编辑器），这里只认同一个写法，
// 给导出（写成不带 id 的可读引用）、一起复制的卡之间的引用换成副本（edit/ops.ts）和旧文件升级用
import type { BoardFile } from "./model";

const REF = /\[\[([^[\]\n]+?)\]\]/g;
const TARGET = /#\^([\w-]+(?:\/[\w-]+)?)$/;

export type MdRef = { label: string; target?: string };
/** [[…]] 里的字 → 标题和目标 id */
export function splitRef(inner: string): MdRef {
  const m = TARGET.exec(inner);
  return m ? { label: inner.slice(0, m.index).trim(), target: m[1] } : { label: inner.trim() };
}

/**
 * 把 md 里每个 [[引用]] 换成 f 给的（undefined = 不动）。围栏代码块和行内代码里的不算引用，不碰；
 * 别的写法（链接、公式）里的 [[ 极少见，和编辑器一样当引用
 */
export function mapRefs(md: string, f: (r: MdRef) => string | undefined): string {
  if (!md.includes("[[")) return md;
  const out: string[] = [];
  let fence = "",
    run: string[] = [];
  const flush = () => {
    if (run.length) out.push(inlineRefs(run.join("\n"), f));
    run = [];
  };
  for (const l of md.split("\n")) {
    const m = /^ {0,3}(`{3,}|~{3,})/.exec(l);
    if (fence) {
      out.push(l);
      if (new RegExp(`^ {0,3}${fence[0]}{${fence.length},}\\s*$`).test(l)) fence = "";
    } else if (m) {
      flush();
      fence = m[1];
      out.push(l);
    } else run.push(l);
  }
  flush();
  return out.join("\n");
}

/** 一段（没有围栏代码块的）字：跳过 `行内代码` */
function inlineRefs(src: string, f: (r: MdRef) => string | undefined): string {
  let out = "",
    i = 0;
  while (i < src.length) {
    const tick = src.indexOf("`", i),
      ref = src.indexOf("[[", i);
    if (ref < 0) break;
    if (tick >= 0 && tick < ref) {
      const n = /^`+/.exec(src.slice(tick))![0].length;
      const close = new RegExp(`(?<!\`)\`{${n}}(?!\`)`).exec(src.slice(tick + n));
      const end = close ? tick + n + close.index + n : tick + n;
      out += src.slice(i, end);
      i = end;
      continue;
    }
    REF.lastIndex = ref;
    const m = REF.exec(src);
    if (!m || m.index !== ref) {
      out += src.slice(i, ref + 2);
      i = ref + 2;
      continue;
    }
    const r = splitRef(m[1]);
    const to = r.label ? f(r) : undefined;
    out += src.slice(i, ref) + (to ?? m[0]);
    i = ref + m[0].length;
  }
  return out + src.slice(i);
}

/** 存 Markdown 的地方：Note 的正文、卡的说明、文字 Sidenote、问题贴纸（Shelf 上的也算；共享卡的引用不是卡，没有） */
export function eachMarkdown(
  b: Pick<BoardFile, "cards" | "sidenotes" | "stickers" | "shelf">,
  f: (md: string) => string,
) {
  for (const c of b.cards) {
    if (c.kind === "shared") continue;
    if (c.kind === "note") {
      const m = f(c.md);
      if (m !== c.md) c.md = m;
    }
    if (c.desc) {
      const d = f(c.desc);
      if (d !== c.desc) c.desc = d;
    }
  }
  for (const n of b.sidenotes)
    if (n.kind === "text") {
      const m = f(n.md);
      if (m !== n.md) n.md = m;
    }
  for (const k of [...b.stickers, ...(b.shelf ?? []).flatMap((e) => e.stickers)])
    if (k.q) {
      const m = f(k.q.md);
      if (m !== k.q.md) k.q.md = m;
    }
}

/** 导出、交给别的应用的 Markdown：[[标题#^id]] 写成 [[标题]]，标题是目标现在的名字（title 认得出 id 时），否则是原文里的 */
export const plainRefs = (md: string, title: (target: string) => string | undefined = () => undefined) =>
  mapRefs(md, (r) =>
    r.target ? `[[${(title(r.target) ?? r.label).replace(/[[\]\n]/g, " ").trim() || r.label}]]` : undefined,
  );

/** 目标换了 id 的（复制出来的副本）：[[标题#^旧]] → [[标题#^新]] */
export const retargetRefs = (md: string, ids: Record<string, string>) =>
  mapRefs(md, (r) => (r.target && Object.hasOwn(ids, r.target) ? `[[${r.label}#^${ids[r.target]}]]` : undefined));
