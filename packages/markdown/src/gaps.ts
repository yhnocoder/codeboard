// The 0.5em between a paragraph and the paragraph or block next to it (markdown.css) is set by classes, not by sibling rules
// (p + p, p + ul, ul + p): with those Chrome restyled every later block of a Note each time a block was inserted or removed
// (Enter, Backspace), which made typing in a long Note slow. The static render (render.ts) and the editor
// (editor/gaps.ts) give the classes to the elements the sibling rules matched, by the elements they draw

/** A paragraph (<p>), a block spaced like one (ul, ol, pre, table, blockquote, details, a formula block), or neither */
export type GapKind = "p" | "block" | null;

/** The class of an element after one of kind prev: md-pp for a paragraph after a paragraph, md-gap for a block after a
 *  paragraph or a paragraph after a block */
export function gapClass(prev: GapKind, kind: GapKind): string | null {
  if (prev === "p") return kind === "p" ? "md-pp" : kind === "block" ? "md-gap" : null;
  return prev === "block" && kind === "p" ? "md-gap" : null;
}

const OPEN = /^<([a-z][a-z0-9]*)([^>]*)>/i;
const BLOCK_TAGS = new Set(["ul", "ol", "pre", "table", "blockquote", "details"]);
/** The kind of the element an HTML string starts with */
export function htmlGapKind(html: string): GapKind {
  const m = OPEN.exec(html);
  if (!m) return null;
  const tag = m[1].toLowerCase();
  if (tag === "p") return "p";
  if (BLOCK_TAGS.has(tag)) return "block";
  const cls = /\sclass="([^"]*)"/.exec(m[2])?.[1].split(/\s+/) ?? [];
  return cls.includes("math") || /\sdata-type="block-math"/.test(m[2]) ? "block" : null;
}

/** The HTML string with cls added to the element it starts with */
export function withClass(html: string, cls: string): string {
  const m = OPEN.exec(html)!;
  const at = /\sclass="/.exec(m[2]);
  if (at) {
    const i = m[1].length + 1 + at.index + at[0].length;
    return `${html.slice(0, i)}${cls} ${html.slice(i)}`;
  }
  const i = m[1].length + 1;
  return `${html.slice(0, i)} class="${cls}"${html.slice(i)}`;
}
