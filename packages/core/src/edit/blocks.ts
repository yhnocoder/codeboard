// Arrow ends on a Note's block follow that block when the Note is rewritten: blocks are matched by kind and likeness.
// Pure functions that change the board passed in (the board calls them inside a mutate).
// Arrow ends on a Note's block follow that block when the Note is rewritten: blocks are matched by kind and likeness.
// Pure functions that change the board passed in (the board calls them inside a mutate).
import { removeLinks } from "./refs";
import { diffArrays } from "diff";
import { blockAt, blockSig, type Board, type Link } from "../model";

/** 一块 Markdown 大致是哪一类：一换一的改写只在同类之间直接配上 */
function blockKind(src: string): string {
  const t = src.trimStart();
  const m = /^(#{1,6}\s|```|~~~|\$\$|>|[-*+]\s|\d+[.)]\s|\||!\[)/.exec(t);
  return m ? m[1].replace(/\d+/, "1").replace(/\s$/, "") : "p";
}
/** 两块字有多像（字符二元组的 Dice 系数，中文没有空格也能比）：0..1 */
function likeness(x: string, y: string): number {
  const grams = (s: string) => {
    const t = s.toLowerCase().replace(/\s+/g, " ").trim(),
      m = new Map<string, number>();
    for (let i = 0; i + 1 < t.length; i++) {
      const g = t.slice(i, i + 2);
      m.set(g, (m.get(g) ?? 0) + 1);
    }
    return m;
  };
  const a = grams(x),
    c = grams(y);
  let both = 0,
    na = 0,
    nc = 0;
  for (const v of a.values()) na += v;
  for (const [g, v] of c) {
    nc += v;
    both += Math.min(v, a.get(g) ?? 0);
  }
  return na + nc ? (2 * both) / (na + nc) : x.trim() === y.trim() ? 1 : 0;
}
/** 改写后还算同一块：字至少这么像 */
const LIKE = 0.3;

/**
 * Note 的块 旧 → 新（下标；-1 = 这一块没了）。没改的块按指纹对上（Myers）；夹在两处没改的之间的一段改动里，
 * 一块换一块、还是同一类的（段落还是段落）算改写；别的配给字最像的那块，够像（LIKE）才算
 */
export function blockMap(old: readonly string[], now: readonly string[]): number[] {
  const out = old.map(() => -1);
  const parts = diffArrays(old.map(blockSig), now.map(blockSig));
  let i = 0,
    j = 0;
  for (let k = 0; k < parts.length; k++) {
    if (!parts[k].added && !parts[k].removed) {
      for (let n = 0; n < parts[k].count; n++) out[i++] = j++;
      continue;
    }
    const dels: number[] = [],
      adds: number[] = [];
    for (; k < parts.length && (parts[k].added || parts[k].removed); k++)
      for (let n = 0; n < parts[k].count; n++) parts[k].removed ? dels.push(i++) : adds.push(j++);
    k--;
    if (dels.length === 1 && adds.length === 1 && blockKind(old[dels[0]]) === blockKind(now[adds[0]])) {
      out[dels[0]] = adds[0];
      continue;
    }
    const used = new Set<number>();
    for (const d of dels) {
      let best = -1,
        score = LIKE;
      for (const a of adds) {
        if (used.has(a)) continue;
        const s = likeness(old[d], now[a]);
        if (s >= score) {
          best = a;
          score = s;
        }
      }
      if (best >= 0) {
        out[d] = best;
        used.add(best);
      }
    }
  }
  return out;
}

/**
 * Note card 的 Markdown 改了（old → now，白板拆好的块原文；拆不开时 null）：连着它某一块的箭头端点跟着那一块走（blockMap），
 * 那一块删掉了就退到整张卡。端点的指纹和 old 里那一块对不上的（连的时候 Note 正开着编辑器、按编辑器里的字连的）直接按指纹在 now 里找。
 * moved：这次改动里新出现的 Note（Split by Headings 拆出来的）和它们的块：删掉的块原样到了那里，端点跟着搬过去
 */
export function rebaseBlocks(
  b: Board,
  card: string,
  old: readonly string[] | null,
  now: readonly string[] | null,
  moved: readonly { card: string; blocks: readonly string[] }[] = [],
): void {
  const ends = b.links.flatMap((l) => [l.from, l.to].filter((e) => e.card === card && e.block).map((e) => ({ l, e })));
  if (!ends.length) return;
  const map = old && now ? blockMap(old, now) : null;
  const sigs = now?.map(blockSig) ?? [];
  const away = new Set<Link>();
  for (const { l, e } of ends) {
    const ref = e.block!;
    const k = map && old && blockSig(old[ref.i] ?? "") === ref.h ? map[ref.i] : blockAt(ref, sigs);
    if (k >= 0 && now) {
      e.block = { i: k, h: sigs[k] };
      continue;
    }
    const to = moved
      .map((m) => ({ card: m.card, i: blockAt({ i: 0, h: ref.h }, m.blocks.map(blockSig)) }))
      .find((m) => m.i >= 0);
    if (to) {
      e.card = to.card;
      e.block = { i: to.i, h: ref.h };
      away.add(l);
    } else delete e.block;
  }
  // 搬过去以后两端落在同一张卡上的箭头删掉（和换卡时一样）
  const same = [...away].filter((l) => l.from.card === l.to.card).map((l) => l.id);
  if (same.length) removeLinks(b, same);
}
