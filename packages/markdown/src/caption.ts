// 图注（图的 title）的读和改：按 Markdown 里写的地址找图，第 nth 张（同一个地址的图可以有几张，按文档里的先后）。
// 改的时候只换那一张图的写法，别处一个字不动；对不上（比如图写在原样的 HTML 里）就整篇按文档写回
import type { JSONContent } from "@tiptap/core";
import { parseMd, serializeMd } from "./schema";
import { captionOf } from "./image";

/** 第 nth 张地址是 src 的图（文档 JSON 里的节点） */
function imageNode(doc: JSONContent, src: string, nth: number): JSONContent | null {
  let k = 0, hit: JSONContent | null = null;
  const walk = (n: JSONContent) => {
    if (hit) return;
    if (n.type === "image" && n.attrs?.src === src && k++ === nth) { hit = n; return; }
    n.content?.forEach(walk);
  };
  walk(doc);
  return hit;
}

/** 图注；没有这张图回 null */
export function imageCaption(md: string, src: string, nth = 0): string | null {
  const n = imageNode(parseMd(md), src, nth);
  return n ? captionOf(n.attrs?.title) : null;
}

const IMAGE = /!\[(?:\\.|[^\]\\\n])*\]\(\s*(<[^>\n]*>|(?:\\.|[^\s()\\]|\([^\s()]*\))+)((?:\s+(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\((?:\\.|[^)\\])*\)))?)\s*\)/g;

/** 代码（围栏代码块、行内代码）换成等长的空白：在里面的 ![…](…) 不是图 */
function maskCode(md: string): string {
  let out = md.replace(/(`+)(?!`)[\s\S]*?[^`]\1(?!`)/g, (m) => m.replace(/[^\n]/g, " "));
  let fence = "";
  out = out.split("\n").map((l) => {
    const f = /^ {0,3}(`{3,}|~{3,})/.exec(l);
    if (fence) { if (f && f[1][0] === fence[0] && f[1].length >= fence.length && !l.slice(f[0].length).trim()) fence = ""; return " ".repeat(l.length); }
    if (f) { fence = f[1]; return " ".repeat(l.length); }
    return l;
  }).join("\n");
  return out;
}

/** 第 nth 张地址是 src 的图换上图注 caption（空 = 去掉）；没有这张图时原样返回 */
export function setImageCaption(md: string, src: string, nth: number, caption: string): string {
  const cap = caption.replace(/\s*\n\s*/g, " ").trim();
  if (!imageNode(parseMd(md), src, nth)) return md;
  const masked = maskCode(md);
  let k = 0, out: string | null = null;
  for (const m of masked.matchAll(IMAGE)) {
    const raw = m[1].startsWith("<") ? m[1].slice(1, -1) : m[1];
    if (raw !== src || k++ !== nth) continue;
    const at = m.index! + m[0].length - 1; // 结尾的 )
    const start = m.index! + m[0].indexOf("](") + 2;
    const title = cap ? ` "${cap.replace(/[\\"]/g, "\\$&")}"` : "";
    out = `${md.slice(0, start)}${m[1]}${title}${md.slice(at)}`;
    break;
  }
  // 照着改完的读一遍：真是那张图换了图注才算数，否则整篇按文档写回
  if (out !== null && captionOf(imageNode(parseMd(out), src, nth)?.attrs?.title) === cap) return out;
  const doc = parseMd(md), n = imageNode(doc, src, nth)!;
  n.attrs = { ...n.attrs, title: cap || null };
  return serializeMd(doc);
}
