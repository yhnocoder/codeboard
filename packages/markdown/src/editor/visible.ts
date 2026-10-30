// The editor counterpart of selmap's docRange. The editor holds Markdown source, so its characters are counted as the
// static render shows them: markers and heading prefixes don't count, a drawn atom (math, image, ref, footnote, <br>,
// inline HTML) is one character, an annotation counts its text, HTML comments are skipped (the static render drops
// them). A key pressed on a selection in the static render then lands on the same characters in the editor.
import type { Node as PMNode } from "@tiptap/pm/model";
import type { StaticTextRange } from "../selmap";
import { blockInfo, type Span } from "./spans";

const LEAF_CHAR = "￼";
type Ch = { from: number; to: number; c: string };

function sourceChars(text: string, base: number, cell: boolean, out: Ch[]) {
  const info = blockInfo(text, !cell);
  const skip = new Uint8Array(text.length);
  const kill = (a: number, b: number) => skip.fill(1, a, b);
  kill(0, info.prefix);
  const atoms: [number, number][] = [];
  const walk = (spans: Span[]) => {
    for (const sp of spans) {
      if (sp.plain) { kill(sp.from, sp.to); continue; }
      const a = sp.atom;
      if (a?.type === "annot" && sp.inner) { kill(sp.from, sp.inner[0]); kill(sp.inner[1], sp.to); continue; }
      if (a) { kill(sp.from, sp.to); atoms.push([sp.from, sp.to]); continue; }
      for (const [x, y] of sp.marks) kill(x, y);
      walk(sp.kids);
    }
  };
  walk(info.spans);
  let ai = 0;
  for (let i = 0; i < text.length; i++) {
    while (ai < atoms.length && atoms[ai][0] === i) { out.push({ from: base + i, to: base + atoms[ai][1], c: LEAF_CHAR }); ai++; }
    if (!skip[i]) out.push({ from: base + i, to: base + i + 1, c: text[i] });
  }
}

/** Where a range counted on the static render (staticTextRange) lies in the editor's document; null when the text differs */
export function visibleRange(doc: PMNode, r: StaticTextRange): { from: number; to: number } | null {
  const chars: Ch[] = [];
  doc.descendants((n, pos, parent) => {
    if (n.isTextblock) {
      const text = n.textContent;
      if (n.type.name === "paragraph") sourceChars(text, pos + 1, /cell/.test(parent?.type.spec.tableRole ?? ""), chars);
      else for (let i = 0; i < text.length; i++) chars.push({ from: pos + 1 + i, to: pos + 2 + i, c: text[i] });
      return false;
    }
    if (n.isLeaf) { chars.push({ from: pos, to: pos + n.nodeSize, c: LEAF_CHAR }); return false; }
    return true;
  });
  if (r.from < 0 || r.to > chars.length || r.to <= r.from) return null;
  const part = chars.slice(r.from, r.to);
  if (part.map((x) => x.c).join("") !== r.text) return null;
  return { from: part[0].from, to: part[part.length - 1].to };
}
