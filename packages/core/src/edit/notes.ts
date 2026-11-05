// Note changes: an image into a Note, Note ↔ Text, [[title]] references following a rename, Split by Headings.
// Pure functions that change the board passed in (the board calls them inside a mutate).
import { removeCards } from "./refs";
import { mdHeading, uid, type Board } from "../model";
import { escapeRegExp } from "@codeboard/analysis/basics";
import { estSize, type Rect } from "../layout";
import { headingTree, splitHeadings } from "../split";

/**
 * Image 卡拖进 Note：图作为单独的一段放进 Note 的 Markdown（src = Note 里写的地址，如 assets/…；图的说明接在图下面），Image 卡连同它的箭头删掉。
 * at = 放在 Markdown 的第几个字（一块的开头，见 @yhnocoder/markdown 的 mdBlockStarts），不给就接在末尾。
 * 不是 Image 卡 / Note 时什么都不改，返回 false
 */
export function imageIntoNote(b: Board, imageId: string, noteId: string, src: string, at?: number): boolean {
  const img = b.cards.find((c) => c.id === imageId),
    note = b.cards.find((c) => c.id === noteId);
  if (img?.kind !== "image" || note?.kind !== "note") return false;
  const alt = (img.alt ?? "").replace(/[[\]\s]+/g, " ").trim();
  // an animated image keeps its frame and always-play, in the Markdown's attribute block (@yhnocoder/markdown imageattrs.ts)
  const attrs = [img.frame ? `frame=${img.frame}` : "", img.loop ? "loop=true" : ""].filter(Boolean).join(" ");
  const block = `![${alt}](${src})${attrs ? `{${attrs}}` : ""}${img.desc?.trim() ? `\n\n${img.desc.trim()}` : ""}`;
  const cut = at === undefined ? note.md.length : Math.max(0, Math.min(at, note.md.length));
  const head = note.md.slice(0, cut).replace(/\s+$/, ""),
    tail = note.md.slice(cut).replace(/\s+$/, "");
  note.md = [head, block, tail].filter(Boolean).join("\n\n");
  removeCards(b, [imageId]);
  return true;
}

// Note 的字在标题栏（36，含下边线）下面、内边距 10 / 14；Text 的内边距 2 / 4
const NOTE_PAD_X = 14 - 4,
  NOTE_HEAD = 36 + 10 - 2;
/**
 * Note ↔ Text（只有这两种互转）。看到的就是全部：Note 卡头的名字（改过的名字）变成 Text 正文的第一行 # 标题；
 * Text 开头的 # 标题本来就显示在 Note 的卡头上（mdHeading），所以 Turn into Note 不用搬字，来回转看起来不变。
 * 卡挪一下：标题落在原来卡头那一行，没有标题时正文留在原地。高度回到跟着内容（Text 没有改高度的把手）
 */
export function turnNoteInto(b: Board, id: string, look: "note" | "text"): void {
  const n = b.cards.find((c) => c.id === id);
  if (n?.kind !== "note" || n.look === look || (n.look !== "note" && n.look !== "text")) return;
  if (look === "text" && n.title) {
    if (mdHeading(n.md) !== n.title) n.md = n.md.trim() ? `# ${n.title}\n\n${n.md}` : `# ${n.title}`;
    delete n.title;
  }
  if (look === "note") {
    delete n.size;
    delete n.bold;
  }
  const headed = !!(n.title || mdHeading(n.md));
  n.look = look;
  const p = b.place[id];
  if (!p) return;
  const s = look === "text" ? 1 : -1,
    dy = headed ? 4 : NOTE_HEAD;
  p.x += s * NOTE_PAD_X;
  p.y += s * dy;
  p.w -= s * 2 * NOTE_PAD_X;
  delete p.h;
}

/** 卡改了名：Note、卡片说明、Text sidenote 里写着 [[旧名]] 的引用跟着改 */
export function renameTitleRefs(b: Board, from: string, to: string): void {
  if (!from || from === to || /[\[\]\n]/.test(to)) return;
  const re = new RegExp(`\\[\\[\\s*${escapeRegExp(from)}\\s*\\]\\]`, "gi");
  const fix = (s: string) => (s.includes("[[") ? s.replace(re, `[[${to}]]`) : s);
  for (const k of b.cards) {
    if (k.kind === "note") {
      const m = fix(k.md);
      if (m !== k.md) k.md = m;
    }
    if (k.desc) {
      const d = fix(k.desc);
      if (d !== k.desc) k.desc = d;
    }
  }
  for (const n of b.sidenotes)
    if (n.kind === "text") {
      const m = fix(n.md);
      if (m !== n.md) n.md = m;
    }
}

/**
 * Split by Headings：Note 按标题拆成几张 Note（规则见 split.ts 的 splitHeadings），一步改动。原卡留着第一个标题前的字
 * （前面没有字时留着第一段），每段一张新 Note，标题行留在它的 Markdown 开头（Note 的卡头就是开头的标题）；
 * 从每张卡连实线箭头到它下一级的卡，原卡连到最上一级的卡。新卡和原卡一样宽、在同一个 Section 里，摆成向下的树（headingTree）。
 * heights：原卡拆完以后的高、每段新卡的高（白板量出来的；不给按估计）；others：别的卡的矩形（新卡尽量不压着它们）。
 * 不是 Note、没有可拆的标题时什么都不改，返回 null；否则返回新卡的 id（按原文的先后）
 */
export function splitNoteByHeadings(
  b: Board,
  id: string,
  o: { heights?: { root: number; parts: number[] }; others?: Rect[]; ids?: string[] } = {},
): string[] | null {
  const n = b.cards.find((c) => c.id === id);
  const sp = n?.kind === "note" ? splitHeadings(n.md) : null;
  if (n?.kind !== "note" || !sp) return null;
  const p = b.place[id] ?? { x: 0, y: 0, w: estSize(n).w };
  const est = (md: string) => 60 + md.split("\n").length * 21;
  const hs = sp.parts.map((q, i) => o.heights?.parts[i] ?? est(q.md));
  const at = headingTree(
    { x: p.x, y: p.y, w: p.w, h: o.heights?.root ?? est(sp.pre) },
    sp.parts.map((q, i) => ({ h: hs[i], parent: q.parent })),
    o.others,
  );
  const ids = sp.parts.map((_, i) => o.ids?.[i] ?? uid("n"));
  n.md = sp.pre;
  delete p.h; // 内容变少了：高度跟着内容
  sp.parts.forEach((q, i) => {
    b.cards.push({ id: ids[i], kind: "note", md: q.md, look: "note" });
    b.place[ids[i]] = { x: at[i].x, y: at[i].y, w: p.w, ...(p.section ? { section: p.section } : {}) };
    b.links.push({ id: uid("l"), from: { card: q.parent < 0 ? id : ids[q.parent] }, to: { card: ids[i] } });
  });
  return ids;
}
