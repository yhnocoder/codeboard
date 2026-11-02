// Web cards and Link Lists: merging into a list, taking a link out of one, removing one
import { findCard, uid, type Card, type LinkItem, type LinksCard, type Place, type WebCard } from "../model";
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
