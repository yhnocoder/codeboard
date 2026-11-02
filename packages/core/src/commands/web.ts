// Web cards and Link Lists: merging into a list, taking a link out of one, removing, renaming and reordering its rows
import {
  findCard,
  uid,
  type Card,
  type LinkItem,
  type LinksCard,
  type Place,
  type WebCard,
  type WebStyle,
} from "../model";
import { defaultWidth } from "../layout";
import { removeCards } from "../edit";
import type { CommandEnv } from "./env";

/** Can these cards make one Link List: two or more Web cards and Link Lists */
export const canLinkList = (cs: Card[]) => cs.length >= 2 && cs.every((c) => c.kind === "web" || c.kind === "links");

const asItem = (c: WebCard): LinkItem => {
  const meta = c.meta ? { ...structuredClone(c.meta) } : undefined;
  if (meta && c.desc) meta.desc = c.desc;
  return { id: uid("l"), url: c.url, title: c.title, meta };
};
const itemsOf = (c: Card): LinkItem[] =>
  c.kind === "web" ? [asItem(c)] : c.kind === "links" ? structuredClone(c.items) : [];

/**
 * Merge Web cards and Link Lists into one Link List: into `target`, or else the top (then leftmost) one; its links first, the
 * others' after in the order given, and those cards go. The list's id and how many links it has, or why not
 */
export function mergeIntoLinkList(
  env: CommandEnv,
  ids: string[],
  target?: string,
): { id: string; links: number } | { why: string } {
  const b0 = env.board();
  const cs = [...new Set(ids)].map((i) => findCard(b0, i)?.host).filter((c): c is Card => !!c);
  if (!canLinkList(cs)) return { why: "Only Web cards and Link Lists can be merged into a Link List" };
  const at = (id: string) => b0.place[id] ?? { x: 0, y: 0 };
  const T =
    (target && cs.find((c) => c.id === target)) ||
    [...cs].sort((a, b) => at(a.id).y - at(b.id).y || at(a.id).x - at(b.id).x)[0];
  const rest = cs.filter((c) => c !== T);
  const items = [...itemsOf(T), ...rest.flatMap(itemsOf)];
  env.edit((b) => {
    const i = b.cards.findIndex((c) => c.id === T.id);
    const t = b.cards[i];
    const next: LinksCard = t.kind === "links" ? { ...t, items } : { id: t.id, kind: "links", items };
    b.cards[i] = next;
    const p = b.place[t.id];
    if (p) {
      p.w = Math.max(p.w, defaultWidth(next));
      delete p.h;
    }
    removeCards(
      b,
      rest.map((c) => c.id),
    );
  });
  return { id: T.id, links: items.length };
}

/** Remove a link from a Link List; the list goes when it was the last */
export function removeLinkItem(env: CommandEnv, id: string, item: string) {
  env.edit((b) => {
    const c = findCard(b, id)?.card;
    if (c?.kind !== "links") return;
    c.items = c.items.filter((x) => x.id !== item);
    if (!c.items.length) removeCards(b, [id]);
  });
}

/**
 * A link taken out of a Link List becomes a Web card at `place(card)` (the shell's layout), in the list's Section; the list goes
 * when it was the last. The new card's id
 */
export function linkItemOut(
  env: CommandEnv,
  id: string,
  item: string,
  place: (card: WebCard) => { x: number; y: number },
): string | null {
  const c0 = findCard(env.board(), id)?.card;
  const it = c0?.kind === "links" ? c0.items.find((x) => x.id === item) : undefined;
  if (!it) return null;
  const nid = uid("w");
  const card: WebCard = {
    id: nid,
    kind: "web",
    url: it.url,
    title: it.title,
    meta: it.meta ? structuredClone(it.meta) : undefined,
  };
  env.edit((b) => {
    const c = findCard(b, id)?.card;
    if (c?.kind !== "links") return;
    c.items = c.items.filter((x) => x.id !== item);
    const p = place(card);
    b.cards.push(card);
    b.place[nid] = {
      x: Math.round(p.x),
      y: Math.round(p.y),
      w: defaultWidth(card),
      section: b.place[id]?.section,
    } as Place;
    if (!c.items.length) removeCards(b, [id]);
  });
  return nid;
}

const editList = (env: CommandEnv, id: string, f: (c: LinksCard) => void) =>
  env.edit((b) => {
    const c = findCard(b, id)?.card;
    if (c?.kind === "links") f(c);
  });

/** Is a Link List's row shown rich: its own choice, else the list's */
export const isRich = (c: LinksCard, it: LinkItem) => it.rich ?? !!c.rich;

/** A Link List's row shown rich or compact; the same as the whole list is not kept for the row */
export function toggleItemRich(env: CommandEnv, id: string, item: string) {
  editList(env, id, (c) => {
    const it = c.items.find((x) => x.id === item);
    if (!it) return;
    const r = !isRich(c, it);
    it.rich = r === !!c.rich ? undefined : r;
  });
}

/**
 * A Link List's rich / compact default. Rows set apart keep their look; those it now matches are no longer kept apart, as
 * toggleItemRich does not keep a row's choice equal to the list's
 */
export function setListRich(env: CommandEnv, id: string, rich: boolean) {
  editList(env, id, (c) => {
    c.rich = rich || undefined;
    for (const it of c.items) if (it.rich === rich) it.rich = undefined;
  });
}

/** A Link List's row renamed; empty, or the page's own title, shows the page's title again */
export function renameLinkItem(env: CommandEnv, id: string, item: string, v: string) {
  editList(env, id, (c) => {
    const it = c.items.find((x) => x.id === item);
    if (it) it.title = v.trim() && v.trim() !== it.meta?.title ? v.trim() : undefined;
  });
}

/** A Link List's row dragged to before the row at index `to` (the rows' order before the move; past the end = last) */
export function moveLinkItem(env: CommandEnv, id: string, item: string, to: number) {
  editList(env, id, (c) => {
    const i = c.items.findIndex((x) => x.id === item);
    if (i < 0) return;
    const [it] = c.items.splice(i, 1);
    c.items.splice(Math.max(0, Math.min(c.items.length, to > i ? to - 1 : to)), 0, it);
  });
}

/** A Web card's look (compact, rich…); none = automatic */
export function setWebStyle(env: CommandEnv, id: string, style: WebStyle | undefined) {
  env.edit((b) => {
    const c = findCard(b, id)?.card;
    if (c?.kind === "web") c.style = style;
  });
}
