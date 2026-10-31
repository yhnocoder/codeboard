// The editor's document ⇄ Markdown. A paragraph, heading or cell in the editor holds that line's Markdown source as plain
// text (no marks, no inline nodes); formatting is only drawn (inline.ts). Blocks (lists, quotes, code, formulas, tables,
// details…) stay nodes. Reading: parseMd makes the document and each paragraph is written back by serializeMd's rules (so,
// as before, what is saved is normalized Markdown). Writing: the source as it is, the blocks put together as before.
// Footnote definitions are paragraphs [^1]: … at the end (as they are written in the source)
import type { JSONContent } from "@tiptap/core";
import type { Node as PMNode } from "@tiptap/pm/model";
import { blocksMd, inlineMd, parseMd, sourceBlocksMd } from "../schema";
import type { MdLayout, TableLayout } from "../layout";

const CODE = new Set(["codeBlock", "blockMath", "toc", "htmlBlock", "horizontalRule", "detailsSummary"]);
const text = (t: string): JSONContent[] | undefined => (t ? [{ type: "text", text: t }] : undefined);

/** A parsed block as the editor's: paragraphs and headings become their source */
export function sourceBlock(n: JSONContent): JSONContent {
  if (n.type === "paragraph" || n.type === "heading") return { type: "paragraph", content: text(inlineMd(n)) };
  if (CODE.has(n.type!) || !n.content) return n;
  return { ...n, content: n.content.map(sourceBlock) };
}

/** Footnote definitions: [^k]: text (continuation lines indented four spaces, as serializeMd writes them); empty ones are left out */
function defs(fns: JSONContent): JSONContent[] {
  return (fns.content ?? []).flatMap((f, i) => {
    const body = blocksMd(f.content ?? []);
    return body ? [{ type: "paragraph", content: text(`[^${i + 1}]: ${body.replace(/\n/g, "\n    ")}`) }] : [];
  });
}

/** Markdown → the editor's document JSON; the layout's widths, heights and wrap go onto their tables and code blocks */
export function sourceDoc(md: string, layout?: MdLayout | null): JSONContent {
  const content: JSONContent[] = [];
  for (const n of parseMd(md).content ?? []) {
    if (n.type === "footnotes") content.push(...defs(n));
    else content.push(sourceBlock(n));
  }
  if (!content.length) content.push({ type: "paragraph" });
  const doc = { type: "doc", content };
  return layout ? withLayout(doc, layout) : doc;
}

const DEF = /^\[\^[^\]\s]+\]:/;
const paraText = (n: JSONContent) => (n.content ?? []).map((c) => c.text ?? "").join("");
/** The editor's document JSON → Markdown. Footnote definitions at the end are one per line (as serializeMd writes them) */
export function sourceMd(doc: JSONContent): string {
  const content = [...(doc.content ?? [])];
  while (
    content.length &&
    content[content.length - 1].type === "paragraph" &&
    !paraText(content[content.length - 1]).trim()
  )
    content.pop();
  let k = content.length;
  while (k > 0 && content[k - 1].type === "paragraph" && DEF.test(paraText(content[k - 1]))) k--;
  const body = sourceBlocksMd(content.slice(0, k)),
    tail = content.slice(k).map(paraText);
  return tail.length ? `${body ? `${body}\n\n` : ""}${tail.join("\n")}` : body;
}

/** The layout of the document's tables and code blocks, by position (null when all are automatic) */
export function layoutOf(doc: PMNode): MdLayout | null {
  const tables: (TableLayout | null)[] = [],
    wrap: number[] = [];
  let code = 0;
  doc.descendants((n) => {
    if (n.type.name === "codeBlock") {
      if (n.attrs.wrap) wrap.push(code);
      code++;
      return false;
    }
    if (n.type.name !== "table") return true;
    const cols: (number | null)[] = [],
      rows: (number | null)[] = [];
    n.firstChild?.forEach((c) => {
      const w = c.attrs.colwidth;
      for (let i = 0; i < (c.attrs.colspan ?? 1); i++) cols.push(Array.isArray(w) && w[i] ? w[i] : null);
    });
    n.forEach((r) => rows.push(r.attrs.height ?? null));
    const t: TableLayout = {};
    if (cols.some((w) => w !== null)) t.cols = cols;
    if (rows.some((h) => h !== null)) t.rows = rows;
    tables.push(t.cols || t.rows ? t : null);
    return false;
  });
  while (tables.length && tables[tables.length - 1] === null) tables.pop();
  const out: MdLayout = {};
  if (tables.length) out.tables = tables;
  if (wrap.length) out.wrap = wrap;
  return out.tables || out.wrap ? out : null;
}

/** The layout put onto the document JSON's tables and code blocks (nth to nth; extra columns and rows are ignored) */
export function withLayout(doc: JSONContent, layout: MdLayout): JSONContent {
  let ti = 0,
    ci = 0;
  const fix = (n: JSONContent): JSONContent => {
    if (n.type === "codeBlock") return layout.wrap?.includes(ci++) ? { ...n, attrs: { ...n.attrs, wrap: true } } : n;
    if (n.type === "table") {
      const t = layout.tables?.[ti++];
      if (!t) return n;
      return {
        ...n,
        content: (n.content ?? []).map((r, ri) => ({
          ...r,
          attrs: { ...r.attrs, height: t.rows?.[ri] ?? null },
          content: (r.content ?? []).map((c, ci2) => ({
            ...c,
            attrs: { ...c.attrs, colwidth: t.cols?.[ci2] ? [t.cols[ci2]] : null },
          })),
        })),
      };
    }
    return n.content && !CODE.has(n.type!) ? { ...n, content: n.content.map(fix) } : n;
  };
  return fix(doc);
}

export const sameLayout = (a: MdLayout | null | undefined, b: MdLayout | null | undefined) =>
  JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
