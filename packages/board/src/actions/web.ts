import {
  uid,
  findCard,
  estSize,
  defaultWidth,
  findFree,
  type LinkItem,
  type LinksCard,
  type WebStyle,
} from "@codeboard/core";
import * as C from "@codeboard/core/commands";
import { commandEnv } from "./env";
import { state, cardById, rectOf } from "../state/store";
import { sync } from "../state/changes";
import { select, sel } from "../state/selection";
import { toast } from "../state/toast";
import { toWorld, viewportCenter } from "../state/camera";
import { setEditing } from "../state/ui";
import { openMenu, type Item } from "../ui/Menu";
import { ask } from "../host";
import { openLink, popCard } from "./common";
import { boardOffset } from "../state/measure";
import { setFetchingKeys, rowDrag, setRowDrag, setGhPicker, type RowDrag } from "../state/web";
import { settleHome } from "../state/sections";
import { track } from "../gesture";

/** 图片地址：assets/ 下的文件名 → webview 能读的 URL */
export const assetSrc = (name?: string) =>
  !name ? undefined : /^(data:|https?:|blob:)/.test(name) ? name : `${state.host.assetBase}/${name}`;

/** 抓一次网页信息存进卡（或 Link List 的一行）。宿主同步来的数据，不进撤销栈 */
export async function fetchMeta(id: string, url: string, item?: string) {
  const k = item ? `${id}/${item}` : id;
  setFetchingKeys((s) => new Set(s).add(k));
  const meta = (await ask("webMeta", { url }).catch(() => null)) ?? { failed: true, at: Date.now() };
  setFetchingKeys((s) => {
    const n = new Set(s);
    n.delete(k);
    return n;
  });
  sync((b) => {
    const c = findCard(b, id)?.card;
    if (c?.kind === "web" && !item && c.url === url) c.meta = meta;
    if (c?.kind === "links") {
      const it = c.items.find((x) => x.id === item);
      if (it && it.url === url) it.meta = meta;
    }
  });
  return meta;
}
/** Retry：重新抓（需要登录的页面在浏览器里打开） */
export async function retryMeta(id: string, item?: string) {
  const c = cardById(id)?.card;
  const url = c?.kind === "web" ? c.url : c?.kind === "links" ? c.items.find((x) => x.id === item)?.url : undefined;
  if (!url) return;
  const m = await fetchMeta(id, url, item);
  if (m.failed)
    toast("Still nothing. The page may need a login: open it in your browser.", [
      { label: "Open in Browser", run: () => openLink(url) },
    ]);
}

/** 一次贴多个链接 → 一张 Link List */
export function newLinkList(urls: string[], at?: { x: number; y: number }) {
  const id = uid("k");
  const items: LinkItem[] = urls.map((url) => ({ id: uid("l"), url }));
  const card: LinksCard = { id, kind: "links", items };
  const size = estSize(card);
  const p0 =
    at ??
    (() => {
      const v = viewportCenter();
      return { x: v.x - size.w / 2, y: v.y - size.h / 2 };
    })();
  C.addCards(commandEnv, [card], {
    place: (_, b) => {
      const p = findFree(
        { ...p0, ...size },
        b.cards.filter((k) => b.place[k.id]).map((k) => rectOf(k)),
      );
      return { x: Math.round(p.x), y: Math.round(p.y), w: defaultWidth(card) };
    },
    settle: settleHome,
  });
  select({ cards: [id] });
  popCard(id);
  for (const it of items) fetchMeta(id, it.url, it.id);
  return id;
}

/** 几张 Web 卡 / Link List 合成一张 Link List（Multi-select → Merge into Link List，或拖到另一张的标题栏上）。
 *  target 留在原地、保留 id（连着它的箭头不断）；其余的行按顺序接在后面 */
export function mergeIntoLinkList(ids: string[] = sel.cards, target?: string) {
  const r = C.mergeIntoLinkList(commandEnv, ids, target);
  if ("why" in r) return toast(r.why);
  select({ cards: [r.id] });
  toast(`Merged into a Link List · ${r.links} links`);
}

const itemOf = (id: string, item: string) => {
  const c = cardById(id)?.card;
  return c?.kind === "links" ? c.items.find((x) => x.id === item) : undefined;
};
export const isRich = C.isRich;

export const setWebStyle = (id: string, style: WebStyle | undefined) => C.setWebStyle(commandEnv, id, style);
/** ⋯ → View ▸ Compact / Rich：整张卡的默认（单独设过的行不变，和新默认一样的不再单独记） */
export const setListRich = (id: string, rich: boolean) => C.setListRich(commandEnv, id, rich);
export const toggleItemRich = (id: string, item: string) => C.toggleItemRich(commandEnv, id, item);
export const renameItem = (id: string, item: string, v: string) => C.renameLinkItem(commandEnv, id, item, v);
export const removeItem = (id: string, item: string) => C.removeLinkItem(commandEnv, id, item);
const reorderItem = (id: string, item: string, to: number) => C.moveLinkItem(commandEnv, id, item, to);
/** 一行拆出来成为单独的 Web 卡（at = 世界坐标；缺省放在卡右边） */
function moveItemOut(id: string, item: string, at?: { x: number; y: number }) {
  const r = rectOf(id);
  const nid = C.linkItemOut(commandEnv, id, item, (card) => {
    if (at) return at;
    const p0 = { x: r.x + r.w + 40, y: r.y };
    return findFree(
      { ...p0, ...estSize(card) },
      state.board.cards.filter((k) => state.board.place[k.id] && k.id !== card.id).map((k) => rectOf(k)),
    );
  });
  if (!nid) return;
  select({ cards: [nid] });
  popCard(nid);
}

export function rowMenu(id: string, item: string, x: number, y: number) {
  const c = cardById(id)?.card;
  const it = itemOf(id, item);
  if (c?.kind !== "links" || !it) return;
  if (!sel.cards.includes(id) || sel.cards.length > 1) select({ cards: [id] });
  openMenu(
    [
      { label: "Open in Browser", kbd: "↵", run: () => openLink(it.url) },
      { label: isRich(c, it) ? "Show as Compact" : "Show as Rich", run: () => toggleItemRich(id, item) },
      { label: "Edit Title", run: () => setEditing({ kind: "title", id: `${id}/${item}` }) },
      ...(it.meta?.failed ? [{ label: "Retry Preview", run: () => retryMeta(id, item) } as Item] : []),
      null,
      { label: "Move Out as Card", run: () => moveItemOut(id, item) },
      { label: "Remove from List", kbd: "⌫", run: () => removeItem(id, item) },
    ],
    x,
    y,
  );
}

// 行拖动：⋮⋮ 上下排序；拖出卡外 = 拆成 Web 卡

export function rowGripDown(e: PointerEvent, id: string, item: string) {
  if (e.button !== 0) return;
  e.preventDefault();
  e.stopPropagation();
  const cardEl = (e.currentTarget as HTMLElement).closest(".card") as HTMLElement | null;
  const it = itemOf(id, item);
  if (!cardEl || !it) return;
  if (!sel.cards.includes(id)) select({ cards: [id] });
  const label = it.title || it.meta?.title || it.url;
  const calc = (ev: PointerEvent): RowDrag => {
    const cr = cardEl.getBoundingClientRect();
    const pad = 18;
    const out =
      ev.clientX < cr.left - pad ||
      ev.clientX > cr.right + pad ||
      ev.clientY < cr.top - pad ||
      ev.clientY > cr.bottom + pad;
    const rows = [...cardEl.querySelectorAll<HTMLElement>(".lrow")];
    let index = rows.length;
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i].getBoundingClientRect();
      if (ev.clientY < r.top + r.height / 2) {
        index = i;
        break;
      }
    }
    return { card: id, item, index, out, x: ev.clientX, y: ev.clientY, label };
  };
  track(
    e,
    (ev) => setRowDrag(calc(ev)),
    (ev, moved) => {
      const d = rowDrag();
      setRowDrag(null);
      if (!moved || !d || ev.type === "pointercancel") return;
      if (d.out) {
        const o = boardOffset();
        const w = toWorld(ev.clientX - o.x, ev.clientY - o.y);
        return moveItemOut(id, item, { x: w.x - 20, y: w.y - 16 });
      }
      reorderItem(id, item, d.index);
    },
  );
}

export function openGitHubPicker(repo?: string) {
  setGhPicker({ repo });
}
