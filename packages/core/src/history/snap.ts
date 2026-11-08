// Board snapshots for undo and saving, on plain objects (no Solid). A snapshot keeps one JSON string per card, place entry,
// link, Section, Sidenote and sticker; a string that did not change reuses the one in the previous snapshot, so 300 undo steps
// hold only the items that changed, not 300 whole boards. The camera is not in a snapshot.
// epoch = how many syncs had run when it was taken: undo / redo back to it replays the syncs after it.
// ids = the ids of each collection (one per piece; saving diffs by id). When they match the previous snapshot it reuses that array.
// step = on an undo-stack snapshot: what changed from it to the next step ("c" / "n" + id; undo checks whether another board
// changed a shared card since). fx = what that step did outside the board (the host made a board): undone / redone with it
import type { Board, Place } from "../model";
import type { BoardPatch, ListPatch } from "../patch";
import type { Marks } from "./track";

export const KEYS = ["cards", "place", "links", "sections", "sidenotes", "stickers"] as const;
export type Key = (typeof KEYS)[number];
export type Ids = Record<Key, string[]>;
/** What one step did outside the board */
export type Effect = { undo: () => void; redo: () => void };
export type Snap = { epoch: number; head: string } & Record<Key, string[]> & { ids: Ids; step?: string[]; fx?: Effect };
/** An undo step's shared item that another board changed since stays as that board left it (undo, and the host's save) */
export const NOT_UNDONE = "Changed on another board; not undone.";

/**
 * Takes snapshots that share unchanged pieces (and id arrays) with the ones before. With marks (track.ts), a collection whose order
 * and members did not change keeps the last snapshot's pieces with only the items written to stringified again, and its id array:
 * an edit costs what it changed, not the board's size. Without them (or when a collection changed) every item is stringified
 */
export function snapper() {
  /** each item's last string, and the object it was read from */
  const last = new Map<string, { o: object; s: string }>();
  let prev: { b: Board; snap: Snap; lists: Record<Key, unknown> } | null = null;
  let marks: Marks | undefined;
  /** item = what is stringified (place: [id, the Place]), o = the item's object */
  function piece(k: string, o: object, item: unknown = o) {
    const p = last.get(k);
    // the same object, not written to since: in a collection that changed (a card added), the others are not read again
    if (p && p.o === o && marks && !marks.all && !marks.items.has(o)) return p.s;
    const s = JSON.stringify(item);
    if (p?.s === s) {
      p.o = o;
      return p.s; // same content: keep the old string, the new one can be collected right away
    }
    last.set(k, { o, s });
    return s;
  }
  /** The last snapshot's pieces of collection k with the marked items read again; null when that is not enough */
  function patched(k: Key, b: Board, m: Marks): string[] | null {
    if (!prev || m.all || m.lists.has(k) || prev.lists[k] !== b[k]) return null;
    let out: string[] | null = null;
    for (const [o, w] of m.items) {
      if (w.k !== k) continue;
      const ps = (out ??= prev.snap[k].slice());
      if (k === "place") {
        const i = indexOf(prev.snap.ids.place, w.at);
        if (i < 0 || b.place[w.at] !== o) return null;
        ps[i] = piece(`p${w.at}`, o, [w.at, o]);
      } else {
        const i = +w.at,
          x = b[k][i];
        if (x !== o || prev.snap.ids[k][i] !== x.id) return null;
        ps[i] = piece(`${PREFIX[k]}${x.id}`, x);
      }
    }
    return out ?? prev.snap[k];
  }
  return {
    take(b: Board, epoch: number, m?: Marks): Snap {
      const { cards, place, links, sections, sidenotes, stickers, cam: _cam, ...head } = b;
      marks = m;
      const p = prev?.snap;
      const s = { epoch, ids: {} as Ids } as Snap;
      for (const k of KEYS) {
        const kept = m && patched(k, b, m);
        if (kept && p) {
          s[k] = kept;
          s.ids[k] = p.ids[k];
          continue;
        }
        if (k === "place") {
          const ids = Object.keys(place);
          s.ids[k] = p && sameArr(ids, p.ids[k]) ? p.ids[k] : ids;
          s[k] = ids.map((id) => piece(`p${id}`, place[id], [id, place[id]]));
        } else {
          const xs = b[k];
          s.ids[k] = idsOf(xs, p?.ids[k]);
          s[k] = xs.map((x) => piece(`${PREFIX[k]}${x.id}`, x));
        }
      }
      s.head = m && p && prev?.b === b && !m.head ? p.head : JSON.stringify(head);
      prev = { b, snap: s, lists: { cards, place, links, sections, sidenotes, stickers } };
      marks = undefined;
      return s;
    },
    /** A new board: nothing to share with */
    reset() {
      last.clear();
      prev = null;
    },
  };
}
/** id → index of an id array, built once per array (an id array is shared until the collection changes) */
const indexes = new WeakMap<string[], Map<string, number>>();
function indexOf(ids: string[], id: string): number {
  let m = indexes.get(ids);
  if (!m) indexes.set(ids, (m = new Map(ids.map((x, i) => [x, i]))));
  return m.get(id) ?? -1;
}
const PREFIX: Record<Key, string> = {
  cards: "c",
  place: "p",
  links: "l",
  sections: "s",
  sidenotes: "n",
  stickers: "k",
};

/** Two snapshots hold the same board, piece by piece (the self-check of the marks: an incremental snapshot against a whole one) */
export function sameContent(a: Snap, b: Snap): string | null {
  if (a.head !== b.head) return "board fields";
  for (const k of KEYS) {
    if (a[k].length !== b[k].length) return k;
    for (let i = 0; i < a[k].length; i++) if (a[k][i] !== b[k][i]) return `${k} ${b.ids[k][i]}`;
  }
  return null;
}

const idsOf = (xs: { id: string }[], prev?: string[]) =>
  prev && prev.length === xs.length && xs.every((x, i) => x.id === prev[i]) ? prev : xs.map((x) => x.id);
const sameArr = (a: string[], b: string[]) => a === b || (a.length === b.length && a.every((x, i) => x === b[i]));
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
      if (a[k] === b[k]) continue; // the same pieces: nothing in it changed
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
    if (pa === pb) return null;
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
