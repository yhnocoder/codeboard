// 小号 Markdown：标题、列表、引用、代码块、粗体 / 斜体 / 行内代码 / 链接，$…$ 和 $$…$$ 公式（KaTeX）。
// 只给 Note、Text、卡片说明、Text sidenote 用，不追求完整。
import katex from "katex";

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function tex(src: string, block: boolean) {
  try { return katex.renderToString(src, { displayMode: block, throwOnError: false, output: "html" }); }
  catch { return `<code>${esc(src)}</code>`; }
}

/** 行内：先把代码和公式挖出来，避免被当成强调 */
export function inline(s: string): string {
  const keep: string[] = [];
  const hold = (h: string) => `\u0000${keep.push(h) - 1}\u0000`;
  s = s.replace(/`([^`]+)`/g, (_, c) => hold(`<code>${esc(c)}</code>`));
  s = s.replace(/\$\$([^$]+)\$\$/g, (_, m) => hold(tex(m, true)));
  // 行内公式照 Pandoc：$ 后紧跟非空白，结尾 $ 前是非空白、后面不是数字。所以 "$5 and $10" 不算公式
  s = s.replace(/(^|[^\\$])\$([^$\s](?:[^$]*[^$\s])?)\$(?!\d)/g, (_, p, m) => p + hold(tex(m, false)));
  s = esc(s);
  s = s.replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, (_, t, u) => `<a class="lnk" data-href="${u}">${t}</a>`);
  s = s.replace(/(^|[\s(])(https?:\/\/[^\s<)]+)/g, (_, p, u) => `${p}<a class="lnk" data-href="${u}">${u}</a>`);
  s = s.replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>").replace(/(^|[^*])\*([^*\s][^*]*)\*/g, "$1<i>$2</i>");
  return s.replace(/\u0000(\d+)\u0000/g, (_, i) => keep[+i]);
}

export function md(src: string): string {
  const lines = src.replace(/\r\n/g, "\n").split("\n");
  const out: string[] = [];
  let list: "ul" | "ol" | null = null;
  const endList = () => { if (list) { out.push(`</${list}>`); list = null; } };
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (/^```/.test(l)) {
      endList();
      const body: string[] = [];
      for (i++; i < lines.length && !/^```/.test(lines[i]); i++) body.push(lines[i]);
      out.push(`<pre><code>${esc(body.join("\n"))}</code></pre>`);
      continue;
    }
    if (/^\s*\$\$\s*$/.test(l)) {
      endList();
      const body: string[] = [];
      for (i++; i < lines.length && !/^\s*\$\$\s*$/.test(lines[i]); i++) body.push(lines[i]);
      out.push(`<div class="math">${tex(body.join("\n"), true)}</div>`);
      continue;
    }
    let m: RegExpMatchArray | null;
    if ((m = l.match(/^(#{1,3})\s+(.*)$/))) { endList(); out.push(`<h${m[1].length}>${inline(m[2])}</h${m[1].length}>`); continue; }
    if ((m = l.match(/^\s*[-*]\s+(.*)$/))) { if (list !== "ul") { endList(); out.push("<ul>"); list = "ul"; } out.push(`<li>${inline(m[1])}</li>`); continue; }
    if ((m = l.match(/^\s*\d+[.)]\s+(.*)$/))) { if (list !== "ol") { endList(); out.push("<ol>"); list = "ol"; } out.push(`<li>${inline(m[1])}</li>`); continue; }
    endList();
    if ((m = l.match(/^>\s?(.*)$/))) { out.push(`<blockquote>${inline(m[1])}</blockquote>`); continue; }
    if (!l.trim()) { out.push(`<div class="sp"></div>`); continue; }
    out.push(`<p>${inline(l)}</p>`);
  }
  endList();
  return out.join("");
}
