// Board snapshots for undo and saving, on plain objects (no Solid). A snapshot keeps one JSON string per card, place entry,
// link, Section, Sidenote and sticker; a string that did not change reuses the one in the previous snapshot, so 300 undo steps
// hold only the items that changed, not 300 whole boards. The camera is not in a snapshot.
// epoch = how many syncs had run when it was taken: undo / redo back to it replays the syncs after it.
// ids = the ids of each collection (one per piece; saving diffs by id). When they match the previous snapshot it reuses that array.
// step = on an undo-stack snapshot: what changed from it to the next step ("c" / "n" + id; undo checks whether another board
// changed a shared card since). fx = what that step did outside the board (the host made a board): undone / redone with it
import type { Board, BoardPatch, ListPatch, Place } from "@codeboard/core";

export const KEYS = ["cards", "place", "links", "sections", "sidenotes", "stickers"] as const;
export type Key = (typeof KEYS)[number];
export type Ids = Record<Key, string[]>;
/** What one step did outside the board */
export type Effect = { undo: () => void; redo: () => void };
export type Snap = { epoch: number; head: string } & Record<Key, string[]> & { ids: Ids; step?: string[]; fx?: Effect };

/** Takes snapshots that share unchanged pieces (and id arrays) with the ones before */
export function snapper() {
  const last = new Map<string, string>();
  let lastIds: Ids | null = null;
  function piece(k: string, o: unknown) {
    const s = JSON.stringify(o);
    const p = last.get(k);
    if (p === s) return p; // same content: keep the old string, the new one can be collected right away
    last.set(k, s);
    return s;
  }
  return {
    take(b: Board, epoch: number): Snap {
      const { cards, place, links, sections, sidenotes, stickers, cam: _cam, ...head } = b;
      const placeIds = Object.keys(place);
      const p = lastIds;
      const ids: Ids = {
        cards: idsOf(cards, p?.cards),
        place: p && sameArr(placeIds, p.place) ? p.place : placeIds,
        links: idsOf(links, p?.links),
        sections: idsOf(sections, p?.sections),
        sidenotes: idsOf(sidenotes, p?.sidenotes),
        stickers: idsOf(stickers, p?.stickers),
      };
      lastIds = ids;
      return {
        epoch,
        head: JSON.stringify(head),
        cards: cards.map((x) => piece(`c${x.id}`, x)),
        place: placeIds.map((id) => piece(`p${id}`, [id, place[id]])),
        links: links.map((x) => piece(`l${x.id}`, x)),
        sections: sections.map((x) => piece(`s${x.id}`, x)),
        sidenotes: sidenotes.map((x) => piece(`n${x.id}`, x)),
        stickers: stickers.map((x) => piece(`k${x.id}`, x)),
        ids,
      };
    },
    /** A new board: nothing to share with */
    reset() {
      last.clear();
      lastIds = null;
    },
  };
}

const idsOf = (xs: { id: string }[], prev?: string[]) =>
  prev && prev.length === xs.length && xs.every((x, i) => x.id === prev[i]) ? prev : xs.map((x) => x.id);
const sameArr = (a: string[], b: string[]) => a.length === b.length && a.every((x, i) => x === b[i]);
export const same = (a: Snap, b: Snap) => a.head === b.head && KEYS.every((k) => sameArr(a[k], b[k]));

/** The board a snapshot holds (camera not included) */
export function parse(s: Snap): Omit<Board, "cam"> {
  const p = (xs: string[]) => xs.map((x) => JSON.parse(x));
  return {
    ...JSON.parse(s.head),
    cards: p(s.cards),
    place: Object.fromEntries(p(s.place)),
    links: p(s.links),
    sections: p(s.sections),
    sidenotes: p(s.sidenotes),
    stickers: p(s.stickers),
  };
}

/** Which cards and Sidenotes changed from a to b ("c" / "n" + id). Same ids (nearly always): compared one by one, else by id */
export function touched(a: Snap, b: Snap): string[] {
  const out: string[] = [];
  for (const [k, p] of [
    ["cards", "c"],
    ["sidenotes", "n"],
  ] as const) {
    const ia = a.ids[k],
      ib = b.ids[k];
    if (ia === ib) {
      for (let i = 0; i < ib.length; i++) if (a[k][i] !== b[k][i]) out.push(p + ib[i]);
      continue;
    }
    const old = new Map(ia.map((id, i) => [id, a[k][i]]));
    ib.forEach((id, i) => {
      if (old.get(id) !== b[k][i]) out.push(p + id);
      old.delete(id);
    });
    for (const id of old.keys()) out.push(p + id);
  }
  return out;
}

/** One item to put back: collection, index (place: its id), the item */
export type ItemOp = [Key, number | string, unknown];
/**
 * now → s when only some items' contents changed (same order, same counts, same board fields): the items to replace.
 * null when it is more than that (the whole board is replaced then)
 */
export function itemOps(now: Snap, s: Snap): ItemOp[] | null {
  if (now.head !== s.head || KEYS.some((k) => now[k].length !== s[k].length)) return null;
  const ops: ItemOp[] = [];
  for (const k of KEYS) {
    for (let i = 0; i < s[k].length; i++) {
      if (s[k][i] === now[k][i]) continue;
      const a = JSON.parse(now[k][i]),
        b = JSON.parse(s[k][i]);
      if (k === "place") {
        if (a[0] !== b[0]) return null;
        ops.push([k, b[0], b[1]]);
      } else {
        if (a.id !== b.id) return null;
        ops.push([k, i, b]);
      }
    }
  }
  return ops;
}

/** What was last sent to the host: a snapshot and the camera key */
export type Sent = { snap: Snap; cam: string };
export const camKey = (c: Board["cam"]) => `${c.x},${c.y},${c.z}`;

/** Last sent a → now b: the items that changed; null when nothing did. a = null sends the whole board */
export function diff(a: Sent | null, b: Snap, cam: Board["cam"]): BoardPatch | null {
  const p: BoardPatch = {};
  const put = p as Record<string, unknown>;
  let any = false;
  // place is [id, Place] in a snapshot, id → Place in a patch
  const places = (xs: unknown[]) => Object.fromEntries(xs as [string, Place][]);
  if (!a) {
    p.full = true;
    for (const k of KEYS) {
      const set = b[k].map((x) => JSON.parse(x));
      put[k] = k === "place" ? { set: places(set) } : { set };
    }
    any = true;
  } else {
    for (const k of KEYS) {
      const d = diffList(a.snap.ids[k], a.snap[k], b.ids[k], b[k], k !== "place");
      if (!d) continue;
      any = true;
      put[k] = k === "place" ? { set: d.set && places(d.set), del: d.del } : d;
    }
  }
  if (!a || a.snap.head !== b.head) {
    const { version: _v, id: _id, ...head } = JSON.parse(b.head);
    p.head = head;
    any = true;
  }
  if (!a || a.cam !== camKey(cam)) {
    p.cam = { ...cam };
    any = true;
  }
  return any ? p : null;
}

function diffList(ia: string[], pa: string[], ib: string[], pb: string[], ordered: boolean): ListPatch<unknown> | null {
  const set: unknown[] = [];
  if (ia === ib) {
    // same ids (a drag, an edit): piece by piece
    for (let i = 0; i < pb.length; i++) if (pa[i] !== pb[i]) set.push(JSON.parse(pb[i]));
    return set.length ? { set } : null;
  }
  const old = new Map(ia.map((id, i) => [id, pa[i]]));
  ib.forEach((id, i) => {
    if (old.get(id) !== pb[i]) set.push(JSON.parse(pb[i]));
  });
  const now = new Set(ib);
  const del = ia.filter((id) => !now.has(id));
  const out: ListPatch<unknown> = {};
  if (set.length) out.set = set;
  if (del.length) out.del = del;
  // order: the host keeps the old order minus the deleted, new ones appended; the full order is sent only when that differs
  if (ordered) {
    const kept = ia.filter((id) => now.has(id)),
      added = ib.filter((id) => !old.has(id));
    const exp = kept.concat(added);
    if (exp.some((id, i) => id !== ib[i])) out.order = ib;
  }
  return set.length || del.length || out.order ? out : null;
}
