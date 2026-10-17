// Web 卡和 Link List：抓网页信息 / Retry、合成 Link List、行的排序 / 拖出 / 切换 Rich、菜单；From GitHub… 面板入口。
import { createSignal } from "solid-js";
import { unwrap } from "solid-js/store";
import {
  uid, findCard, removeCards, estSize, defaultWidth, findFree,
  type Board, type Card, type LinkItem, type LinksCard, type WebCard, type WebStyle, type Place,
} from "@codeboard/core";
import { state, mutate, sync, select, cardById, rectOf, placeOf, toast, sel } from "../state/store";
import { toWorld, viewportCenter } from "../state/camera";
import { setEditing } from "../state/ui";
import { openMenu, type Item } from "../ui/Menu";
import { ask } from "../host";
import { boardOffset, openLink, popCard } from "./common";

/** 图片地址：assets/ 下的文件名 → webview 能读的 URL */
export const assetSrc = (name?: string) => (!name ? undefined : /^(data:|https?:|blob:)/.test(name) ? name : `${state.host.assetBase}/${name}`);

// ---------- 抓网页信息 ----------

const [busy, setBusy] = createSignal<Set<string>>(new Set());
/** 正在抓：key = 卡 id，或「卡 id/行 id」 */
export const fetching = (k: string) => busy().has(k);

/** 抓一次网页信息存进卡（或 Link List 的一行）。宿主同步来的数据，不进撤销栈 */
export async function fetchMeta(id: string, url: string, item?: string) {
  const k = item ? `${id}/${item}` : id;
  setBusy((s) => new Set(s).add(k));
  const meta = (await ask("webMeta", { url }).catch(() => null)) ?? { failed: true, at: Date.now() };
  setBusy((s) => { const n = new Set(s); n.delete(k); return n; });
  sync((b) => {
    const c = findCard(b, id)?.card;
    if (c?.kind === "web" && !item && c.url === url) c.meta = meta;
    if (c?.kind === "links") { const it = c.items.find((x) => x.id === item); if (it && it.url === url) it.meta = meta; }
  });
  return meta;
}
/** Retry：重新抓（需要登录的页面在浏览器里打开） */
export async function retryMeta(id: string, item?: string) {
  const c = cardById(id)?.card;
  const url = c?.kind === "web" ? c.url : c?.kind === "links" ? c.items.find((x) => x.id === item)?.url : undefined;
  if (!url) return;
  const m = await fetchMeta(id, url, item);
  if (m.failed) toast("Still nothing. The page may need a login: open it in your browser.", [{ label: "Open in Browser", run: () => openLink(url) }]);
}

// ---------- Link List ----------

const asItem = (c: WebCard): LinkItem => {
  const meta = c.meta ? { ...structuredClone(unwrap(c.meta)) } : undefined;
  if (meta && c.desc) meta.desc = c.desc;
  return { id: uid("l"), url: c.url, title: c.title, meta };
};
const itemsOf = (c: Card): LinkItem[] => (c.kind === "web" ? [asItem(c)] : c.kind === "links" ? structuredClone(unwrap(c.items)) : []);
export const canLinkList = (cs: Card[]) => cs.length >= 2 && cs.every((c) => c.kind === "web" || c.kind === "links");

/** 一次贴多个链接 → 一张 Link List */
export function newLinkList(urls: string[], at?: { x: number; y: number }) {
  const id = uid("k");
  const items: LinkItem[] = urls.map((url) => ({ id: uid("l"), url }));
  const card: LinksCard = { id, kind: "links", items };
  const size = estSize(card);
  const p0 = at ?? (() => { const v = viewportCenter(); return { x: v.x - size.w / 2, y: v.y - size.h / 2 }; })();
  mutate((b) => {
    const p = findFree({ ...p0, ...size }, b.cards.filter((k) => b.place[k.id]).map((k) => rectOf(k)));
    b.cards.push(card);
    b.place[id] = { x: Math.round(p.x), y: Math.round(p.y), w: defaultWidth(card) };
  });
  select({ cards: [id] });
  popCard(id);
  for (const it of items) fetchMeta(id, it.url, it.id);
  return id;
}

/** 几张 Web 卡 / Link List 合成一张 Link List（Multi-select → Merge into Link List，或拖到另一张的标题栏上）。
 *  target 留在原地、保留 id（连着它的箭头不断）；其余的行按顺序接在后面 */
export function mergeIntoLinkList(ids: string[] = sel.cards, target?: string) {
  const cs = [...new Set(ids)].map((i) => cardById(i)?.host).filter(Boolean) as Card[];
  if (!canLinkList(cs)) return toast("Only Web cards and Link Lists can be merged into a Link List");
  // 默认合到最上面（再最左）那张
  const T = (target && cs.find((c) => c.id === target)) || [...cs].sort((a, b) => placeOf(a.id).y - placeOf(b.id).y || placeOf(a.id).x - placeOf(b.id).x)[0];
  const rest = cs.filter((c) => c !== T);
  const n = cs.reduce((s, c) => s + itemsOf(c).length, 0);
  mutate((b) => {
    const i = b.cards.findIndex((c) => c.id === T.id);
    const t = b.cards[i];
    const items = [...itemsOf(t), ...rest.flatMap(itemsOf)];
    const next: LinksCard = t.kind === "links" ? { ...t, items } : { id: t.id, kind: "links", items };
    b.cards[i] = next;
    const p = b.place[t.id];
    if (p) { p.w = Math.max(p.w, defaultWidth(next)); delete p.h; }
    removeCards(b, rest.map((c) => c.id));
  });
  select({ cards: [T.id] });
  toast(`Merged into a Link List · ${n} links`);
}

const setList = (id: string, f: (c: LinksCard, b: Board) => void) => mutate((b) => { const c = findCard(b, id)?.card; if (c?.kind === "links") f(c, b); });
const itemOf = (id: string, item: string) => { const c = cardById(id)?.card; return c?.kind === "links" ? c.items.find((x) => x.id === item) : undefined; };
export const isRich = (c: LinksCard, it: LinkItem) => it.rich ?? !!c.rich;

/** ⋯ → View ▸ Compact / Rich：整张卡的默认（单独设过的行不变） */
export function setWebStyle(id: string, style: WebStyle | undefined) {
  mutate((b) => { const c = findCard(b, id)?.card; if (c?.kind === "web") c.style = style; });
}
export const setListRich = (id: string, rich: boolean) => setList(id, (c) => { c.rich = rich || undefined; });
export const toggleItemRich = (id: string, item: string) => setList(id, (c) => {
  const it = c.items.find((x) => x.id === item);
  if (!it) return;
  const r = !isRich(c, it);
  it.rich = r === !!c.rich ? undefined : r; // 跟整张卡一样就不单独记
});
export const renameItem = (id: string, item: string, v: string) => setList(id, (c) => {
  const it = c.items.find((x) => x.id === item);
  if (it) it.title = v.trim() && v.trim() !== it.meta?.title ? v.trim() : undefined;
});
export function removeItem(id: string, item: string) {
  setList(id, (c, b) => { c.items = c.items.filter((x) => x.id !== item); if (!c.items.length) removeCards(b, [id]); });
}
const reorderItem = (id: string, item: string, to: number) => setList(id, (c) => {
  const i = c.items.findIndex((x) => x.id === item);
  if (i < 0) return;
  const [it] = c.items.splice(i, 1);
  c.items.splice(Math.max(0, Math.min(c.items.length, to > i ? to - 1 : to)), 0, it);
});
/** 一行拆出来成为单独的 Web 卡（at = 世界坐标；缺省放在卡右边） */
function moveItemOut(id: string, item: string, at?: { x: number; y: number }) {
  const it = itemOf(id, item);
  if (!it) return;
  const nid = uid("w");
  const card: WebCard = { id: nid, kind: "web", url: it.url, title: it.title, meta: it.meta ? structuredClone(unwrap(it.meta)) : undefined };
  const r = rectOf(id);
  mutate((b) => {
    const c = findCard(b, id)?.card;
    if (c?.kind !== "links") return;
    c.items = c.items.filter((x) => x.id !== item);
    const size = estSize(card);
    const p0 = at ?? { x: r.x + r.w + 40, y: r.y };
    const p = at ? p0 : findFree({ ...p0, ...size }, b.cards.filter((k) => b.place[k.id] && k.id !== nid).map((k) => rectOf(k)));
    b.cards.push(card);
    b.place[nid] = { x: Math.round(p.x), y: Math.round(p.y), w: defaultWidth(card), section: b.place[id]?.section } as Place;
    if (!c.items.length) removeCards(b, [id]);
  });
  select({ cards: [nid] });
  popCard(nid);
}

// ---------- 菜单 ----------

/** Web 卡 / Link List 的 ⋯ 菜单里自己的那几项（通用项由 cardMenu 接在后面） */
/** 右键一行 */
export function rowMenu(id: string, item: string, x: number, y: number) {
  const c = cardById(id)?.card;
  const it = itemOf(id, item);
  if (c?.kind !== "links" || !it) return;
  if (!sel.cards.includes(id) || sel.cards.length > 1) select({ cards: [id] });
  openMenu([
    { label: "Open in Browser", kbd: "↵", run: () => openLink(it.url) },
    { label: isRich(c, it) ? "Show as Compact" : "Show as Rich", run: () => toggleItemRich(id, item) },
    { label: "Edit Title", run: () => setEditing({ kind: "title", id: `${id}/${item}` }) },
    ...(it.meta?.failed ? [{ label: "Retry Preview", run: () => retryMeta(id, item) } as Item] : []),
    null,
    { label: "Move Out as Card", run: () => moveItemOut(id, item) },
    { label: "Remove from List", kbd: "⌫", run: () => removeItem(id, item) },
  ], x, y);
}

// ---------- 行拖动：⋮⋮ 上下排序；拖出卡外 = 拆成 Web 卡 ----------

export type RowDrag = { card: string; item: string; index: number; out: boolean; x: number; y: number; label: string };
export const [rowDrag, setRowDrag] = createSignal<RowDrag | null>(null);

export function rowGripDown(e: PointerEvent, id: string, item: string) {
  if (e.button !== 0) return;
  e.preventDefault();
  e.stopPropagation();
  const cardEl = (e.currentTarget as HTMLElement).closest(".card") as HTMLElement | null;
  const it = itemOf(id, item);
  if (!cardEl || !it) return;
  if (!sel.cards.includes(id)) select({ cards: [id] });
  const sx = e.clientX, sy = e.clientY;
  let moved = false;
  const label = it.title || it.meta?.title || it.url;
  const calc = (ev: PointerEvent): RowDrag => {
    const cr = cardEl.getBoundingClientRect();
    const pad = 18;
    const out = ev.clientX < cr.left - pad || ev.clientX > cr.right + pad || ev.clientY < cr.top - pad || ev.clientY > cr.bottom + pad;
    const rows = [...cardEl.querySelectorAll<HTMLElement>(".lrow")];
    let index = rows.length;
    for (let i = 0; i < rows.length; i++) { const r = rows[i].getBoundingClientRect(); if (ev.clientY < r.top + r.height / 2) { index = i; break; } }
    return { card: id, item, index, out, x: ev.clientX, y: ev.clientY, label };
  };
  const onMove = (ev: PointerEvent) => {
    if (!moved && Math.hypot(ev.clientX - sx, ev.clientY - sy) < 3) return;
    moved = true;
    setRowDrag(calc(ev));
  };
  const onUp = (ev: PointerEvent) => {
    window.removeEventListener("pointermove", onMove, true);
    window.removeEventListener("pointerup", onUp, true);
    window.removeEventListener("pointercancel", onUp, true);
    const d = rowDrag();
    setRowDrag(null);
    if (!moved || !d || ev.type === "pointercancel") return;
    if (d.out) {
      const o = boardOffset();
      const w = toWorld(ev.clientX - o.x, ev.clientY - o.y);
      return moveItemOut(id, item, { x: w.x - 20, y: w.y - 16 });
    }
    reorderItem(id, item, d.index);
  };
  window.addEventListener("pointermove", onMove, true);
  window.addEventListener("pointerup", onUp, true);
  window.addEventListener("pointercancel", onUp, true);
}

// ---------- From GitHub… ----------

/** 打开 From GitHub… 面板（工具栏 Code ▾、侧栏 Add Repo… 都走这里）；repo 可以预填 owner/repo 或链接 */
export const [ghPicker, setGhPicker] = createSignal<false | { repo?: string }>(false);
export function openGitHubPicker(repo?: string) { setGhPicker({ repo }); }

