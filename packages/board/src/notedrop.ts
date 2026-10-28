// 图片卡拖到 Note / Text 上：图放在松手处的两块之间。进到这张 Note 时量一次（每一块的上下沿，换成世界坐标），
// 之后每次 pointermove 只拿指针的世界坐标和量好的数比，不读排版；落点换了才写一次落点线的位置（卡上的 CSS 变量）
import { mdBlockStarts } from "@yhnocoder/markdown";
import { worldAt } from "./state/measure";
import { cardById } from "./state/store";

type Slots = {
  card: string;
  el: HTMLElement;
  /** 第 j 个落点：放在第 block 块前面（Infinity = 末尾），判定线（世界坐标的 y），落点线画在 .cface 里的 y（卡自己的像素） */
  slots: { block: number; wy: number; y: number }[];
  /** 当前的落点 */
  cur: number;
};
let on: Slots | null = null;

/** Note 的正文里显示着的顶层块，和 Markdown 的块一一对上时给出它们；正在编辑、没渲染完、对不上时给 null（图放在末尾） */
function blocksOf(body: HTMLElement | null, md: string): HTMLElement[] | null {
  if (!body || body.querySelector(".md-pm")) return null;
  const starts = mdBlockStarts(md), kids = [...body.children] as HTMLElement[];
  return starts && starts.length === kids.length ? kids : null;
}

function measure(id: string): Slots | null {
  const el = document.querySelector<HTMLElement>(`.card[data-id="${CSS.escape(id)}"]`);
  const face = el?.querySelector<HTMLElement>(":scope > .cface");
  const c = cardById(id)?.card;
  if (!el || !face || c?.kind !== "note") return null;
  const body = face.querySelector<HTMLElement>(":scope > .md");
  const fr = face.getBoundingClientRect(), k = fr.width / face.offsetWidth || 1;
  const br = (body ?? face).getBoundingClientRect();
  const local = (cy: number) => Math.min(Math.max((cy - fr.top) / k, (br.top - fr.top) / k), (br.bottom - fr.top) / k);
  const kids = blocksOf(body, c.md) ?? [];
  const shown = kids.map((e, i) => ({ i, r: e.getBoundingClientRect() })).filter((b) => b.r.height > 0);
  const slots: Slots["slots"] = [];
  const pad = 3 * k;
  // 第 j 个落点管到第 j 块的中线为止：指针在它上面就放在它前面
  shown.forEach((b, j) => {
    const top = j ? (shown[j - 1].r.bottom + b.r.top) / 2 : b.r.top - pad;
    slots.push({ block: b.i, wy: worldAt({ x: 0, y: (b.r.top + b.r.bottom) / 2 }).y, y: local(top) });
  });
  const last = shown.length ? shown[shown.length - 1].r.bottom + pad : br.bottom - 9 * k;
  slots.push({ block: Infinity, wy: Infinity, y: local(last) });
  return { card: id, el, slots, cur: -1 };
}

/** 拖着图片卡在 Note id 上移动（pointer：屏幕坐标） */
export function overNote(id: string, pointer: { x: number; y: number }) {
  if (on?.card !== id) { leaveNote(); on = measure(id); }
  if (!on) return;
  const wy = worldAt(pointer).y;
  const j = on.slots.findIndex((s) => wy < s.wy);
  if (j === on.cur) return;
  on.cur = j;
  on.el.style.setProperty("--drop-y", `${on.slots[j].y}px`);
}

/** 拖出了 Note、松手、作废：落点线的位置去掉 */
export function leaveNote() {
  on?.el.style.removeProperty("--drop-y");
  on = null;
}

/**
 * 松手时图放在 Markdown 的第几个字（undefined = 末尾）：按当前的 Markdown 重新对一遍块（量的时候以后 Markdown 可能变了）
 */
export function noteDropAt(id: string): number | undefined {
  if (on?.card !== id || on.cur < 0) return undefined;
  const block = on.slots[on.cur].block, c = cardById(id)?.card;
  if (c?.kind !== "note") return undefined;
  const starts = mdBlockStarts(c.md);
  return starts && block < starts.length ? starts[block] : undefined;
}
