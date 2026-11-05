// 白板的印章（Mark）：几个字 + 一种颜色，[[引用]] 指向别的白板时画在标题前面，代替那块白板的全名。
// 存在白板自己的文件里（Board.seal），没写的字段用默认的：字取名字里实词的首字母，颜色按白板 id 在 SEAL_COLORS 里挑。
// 「书」= 子白板树最上面那块白板（侧栏顶层的）：同一本书里的引用只画目标白板的印章，别的书里的前面再加上那本书的。
import type { Board, BoardMeta, BoardSeal } from "./model";

/** 印章的八种颜色（名字存进白板文件；白板界面的主题里每种有亮、暗两个值：--seal-<名字>） */
export const SEAL_COLORS = ["vermilion", "amber", "olive", "teal", "ink", "plum", "rose", "graphite"] as const;
export type SealColor = (typeof SEAL_COLORS)[number];
/** 用户写的字最多几个：中日韩字符、别的（不算空白）各算各的 */
export const SEAL_MAX_CJK = 5,
  SEAL_MAX_OTHER = 12;

const STOP = new Set(["and", "of", "the", "a", "an", "for", "to", "in", "on", "with"]);
const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;

/**
 * 默认的字：名字按空格和连字符分成词，只有一个词时就是这个词；否则每个实词（跳过 and / of / the…）取首字母、大写，
 * 全大写的词（LLM、CUDA）整个留着。超出长度的截掉（cleanSealText）
 */
export function defaultSealText(name: string): string {
  const words = name.split(/[\s\-–—]+/).filter(Boolean);
  if (words.length <= 1) return cleanSealText(words[0] ?? "");
  const content = words.filter((w) => !STOP.has(w.toLowerCase()));
  const out = (content.length ? content : words).map((w) =>
    /^\p{Lu}{2,}$/u.test(w) ? w : [...w][0].toLocaleUpperCase(),
  );
  return cleanSealText(out.join(""));
}

/** 用户写的字整理一下：去掉空白，中日韩字符最多 SEAL_MAX_CJK 个、别的最多 SEAL_MAX_OTHER 个（多出来的丢掉） */
export function cleanSealText(text: string): string {
  let cjk = 0,
    other = 0,
    out = "";
  for (const ch of text) {
    if (/\s/u.test(ch)) continue;
    if (CJK.test(ch)) {
      if (cjk >= SEAL_MAX_CJK) continue;
      cjk++;
    } else {
      if (other >= SEAL_MAX_OTHER) continue;
      other++;
    }
    out += ch;
  }
  return out;
}
/** 存得进白板文件的字：不空、没有空白、不超长 */
export const sealTextOk = (t: string) => t.length > 0 && cleanSealText(t) === t;

/** 默认的颜色：白板 id 的哈希（FNV-1a）在 SEAL_COLORS 里挑一种，同一块白板在哪儿都一样 */
export function defaultSealColor(id: string): SealColor {
  let h = 0x811c9dc5;
  for (let i = 0; i < id.length; i++) h = Math.imul(h ^ id.charCodeAt(i), 0x01000193);
  return SEAL_COLORS[(h >>> 0) % SEAL_COLORS.length];
}

/** 一块白板现在的印章：自己写的，没写的字段用默认的 */
export type Seal = { text: string; color: SealColor };
export function sealOf(b: { id: string; name: string; seal?: BoardSeal }): Seal {
  return {
    text: b.seal?.text || defaultSealText(b.name.trim()) || "·",
    color: b.seal?.color ?? defaultSealColor(b.id),
  };
}
/** 编辑框里写的 → 存进白板的：和默认的一样的字段不存；都不存时 undefined（用默认的） */
export function sealToKeep(b: { id: string; name: string }, text: string, color: SealColor): BoardSeal | undefined {
  const t = cleanSealText(text),
    out: BoardSeal = {};
  if (t && t !== defaultSealText(b.name.trim())) out.text = t;
  if (color !== defaultSealColor(b.id)) out.color = color;
  return out.text || out.color ? out : undefined;
}

/** 白板 b 换上这个印章：只留过得了检查的字段（字不合格的不要），什么都不剩时去掉（用默认的） */
export function putSeal(b: Pick<Board, "seal">, seal: BoardSeal | null | undefined) {
  const s: BoardSeal = {};
  if (seal?.text && sealTextOk(seal.text)) s.text = seal.text;
  if (seal?.color && (SEAL_COLORS as readonly string[]).includes(seal.color)) s.color = seal.color;
  if (s.text || s.color) b.seal = s;
  else delete b.seal;
}

type Tree = Pick<BoardMeta, "id" | "subs">[];
/**
 * 白板 id 所在的书和一路下来的白板（书在前，id 在最后）：一路往上找嵌着它的白板，走到没有父白板的那块。有几块父白板时取列表里
 * 先出现的那块；套成了环（手改过文件）就停在环里最后走到的那块。不在列表里的白板自己就是书
 */
export function bookPath(id: string, metas: Tree): string[] {
  const out = [id];
  for (;;) {
    const at = out[0];
    const up = metas.find((m) => m.id !== at && !out.includes(m.id) && m.subs?.includes(at));
    if (!up) return out;
    out.unshift(up.id);
  }
}
export const bookOf = (id: string, metas: Tree) => bookPath(id, metas)[0];

/** 引用上画的印章：目标白板的；目标在别的书里时 book = 那本书的（画在前半截） */
export type RefSealOf = Seal & { book?: Seal };
/**
 * 从白板 here 上引用白板 target（上的卡）时画的印章：target 就是 here 时不画（undefined）；同一本书里的、target 自己就是一本书时
 * 只画它的；别的书里的前面加上那本书的（中间隔几层都不写）
 */
export function refSeal(
  target: string,
  here: string,
  metas: Pick<BoardMeta, "id" | "name" | "subs" | "seal">[],
): RefSealOf | undefined {
  if (target === here) return;
  const m = metas.find((x) => x.id === target);
  if (!m) return;
  const own = sealOf(m),
    tb = bookOf(target, metas);
  if (tb === target || tb === bookOf(here, metas)) return own;
  const bm = metas.find((x) => x.id === tb);
  return bm ? { ...own, book: sealOf(bm) } : own;
}

/** 同一本书里别的白板已经在用这几个字（不分大小写）：编辑框里提醒一下（不拦着）。返回那块白板 */
export function sealClash<M extends Pick<BoardMeta, "id" | "name" | "subs" | "seal">>(
  id: string,
  text: string,
  metas: M[],
): M | undefined {
  const t = text.toLowerCase(),
    book = bookOf(id, metas);
  if (!t) return;
  return metas.find((m) => m.id !== id && sealOf(m).text.toLowerCase() === t && bookOf(m.id, metas) === book);
}
