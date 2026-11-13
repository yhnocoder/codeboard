// Moving whole top-level blocks (as mdBlockStarts splits them) out of one Markdown text and into another, with the layout
// (table sizes, code wrap: by position, layout.ts) moving with its tables and code blocks. Untouched blocks keep their source
// as written; blocks are joined by a blank line (a list put after a list of its kind changes its markers, or the two would
// read as one)
import type { JSONContent } from "@tiptap/core";
import { mdBlockStarts, parseMd } from "./schema";
import type { MdLayout, TableLayout } from "./layout";

/** A Markdown text with its layout */
export type MdPart = { md: string; layout: MdLayout | null };

/** One block: its source and the layout of its own tables and code blocks */
type Block = { src: string; tables: (TableLayout | null)[]; wrap: boolean[] };

/** Tables and code blocks in a block, in the order layout.ts numbers them (a code block or table is not looked into) */
function counts(n: JSONContent, c = { t: 0, k: 0 }) {
  if (n.type === "codeBlock") c.k++;
  else if (n.type === "table") c.t++;
  else for (const k of n.content ?? []) counts(k, c);
  return c;
}

function split(p: MdPart): Block[] | null {
  const starts = mdBlockStarts(p.md);
  if (!starts) return null;
  const nodes = parseMd(p.md).content ?? [];
  if (nodes.length !== starts.length) return null;
  let t = 0,
    k = 0;
  return starts.map((s, i) => {
    const c = counts(nodes[i]);
    const b: Block = {
      src: p.md.slice(s, starts[i + 1] ?? p.md.length).replace(/\n\s*$/, ""),
      tables: Array.from({ length: c.t }, (_, j) => p.layout?.tables?.[t + j] ?? null),
      wrap: Array.from({ length: c.k }, (_, j) => !!p.layout?.wrap?.includes(k + j)),
    };
    t += c.t;
    k += c.k;
    return b;
  });
}

/** Top-level blocks Markdown reads in a text */
const blockCount = (md: string) => parseMd(md).content?.length ?? 0;
/**
 * b's source written so that it stays its own block after a: a list right after a list of the same kind would continue it
 * (one list, the block indexes after it off by one), so b's item markers change to the other bullet (- *) or delimiter (. ))
 */
function apart(a: string, b: string): string {
  const m = /^( {0,3})([-*+]|\d{1,9}[.)])[ \t]/.exec(b);
  if (!m || blockCount(`${a}\n\n${b}`) === blockCount(a) + blockCount(b)) return b;
  const ind = m[1],
    other = (k: string) =>
      k === "-" ? "*" : k === "*" || k === "+" ? "-" : k.endsWith(".") ? `${k.slice(0, -1)})` : `${k.slice(0, -1)}.`;
  const re = new RegExp(`^${ind}([-*+]|\\d{1,9}[.)])(?=[ \\t])`, "gm");
  return b.replace(re, (_, k: string) => `${ind}${other(k)}`);
}

function join(bs: Block[]): MdPart {
  const tables = bs.flatMap((b) => b.tables),
    wrap = bs.flatMap((b) => b.wrap).flatMap((w, i) => (w ? [i] : []));
  while (tables.length && tables[tables.length - 1] === null) tables.pop();
  const layout: MdLayout = {};
  if (tables.length) layout.tables = tables;
  if (wrap.length) layout.wrap = wrap;
  const srcs = bs.map((b) => b.src).filter(Boolean);
  for (let i = 1; i < srcs.length; i++) srcs[i] = apart(srcs[i - 1], srcs[i]);
  return {
    md: srcs.join("\n\n"),
    layout: layout.tables || layout.wrap ? layout : null,
  };
}

/** Blocks from..to-1 taken out of src: what is left, and the blocks themselves. Null when src can't be split or the range is wrong */
export function cutMdBlocks(src: MdPart, from: number, to: number): { rest: MdPart; part: MdPart } | null {
  const bs = split(src);
  if (!bs || from < 0 || to > bs.length || from >= to) return null;
  return { rest: join([...bs.slice(0, from), ...bs.slice(to)]), part: join(bs.slice(from, to)) };
}

/** part's blocks put before block at of dst (at = the block count: at the end) */
export function insertMdBlocks(dst: MdPart, at: number, part: MdPart): MdPart | null {
  const bs = dst.md.trim() ? split(dst) : [],
    ps = split(part);
  if (!bs || !ps || at < 0 || at > bs.length) return null;
  return join([...bs.slice(0, at), ...ps, ...bs.slice(at)]);
}

/** Blocks from..to-1 moved before block at of the same text (at counted before the move) */
export function moveMdBlocks(src: MdPart, from: number, to: number, at: number): MdPart | null {
  const bs = split(src);
  if (!bs || from < 0 || to > bs.length || from >= to || at < 0 || at > bs.length) return null;
  if (at >= from && at <= to) return null;
  const moved = bs.slice(from, to),
    rest = [...bs.slice(0, from), ...bs.slice(to)],
    k = at > to ? at - (to - from) : at;
  return join([...rest.slice(0, k), ...moved, ...rest.slice(k)]);
}

/**
 * Where part's blocks are in src (the first block and the one after the last), read as Markdown, not compared as written: the
 * same blocks written differently (an editor normalizes what it saves) still match. Of several matches the one starting nearest
 * to near. Null when they are not there
 */
export function findMdBlocks(src: string, part: string, near = 0): [number, number] | null {
  const bs = split({ md: src, layout: null }),
    ps = split({ md: part, layout: null });
  if (!bs || !ps || !ps.length) return null;
  const key = (s: string) => JSON.stringify(parseMd(s).content);
  const want = ps.map((p) => key(p.src)),
    have = bs.map((b) => key(b.src));
  let best: number | null = null;
  for (let i = 0; i + want.length <= have.length; i++)
    if (want.every((w, j) => have[i + j] === w) && (best === null || Math.abs(i - near) < Math.abs(best - near)))
      best = i;
  return best === null ? null : [best, best + want.length];
}
