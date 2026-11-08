// Which items a change wrote to, so a snapshot stringifies only those (snap.ts) and an edit costs what it changed, not the board's
// size. Every change the engine makes goes through `wrap`: the board a change gets is a proxy over the shell's (a Solid draft, or the
// plain object) that marks, on any write at any depth, the item it is under (the card, place entry, link, Section, Sidenote or
// sticker, by its raw object) or the board's own fields (head). Items replaced, added, moved or deleted need no mark: the snapshot
// finds them by identity. A plain-object board gets the proxies' targets back on every write, never the proxies themselves.
import type { Board } from "../model";
import type { Raw } from "./upkeep";
import { KEYS, type Key } from "./snap";

/** What the next snapshot must stringify again */
export interface Marks {
  /** Everything (the shell replaced the board) */
  all: boolean;
  /** A board field (not a collection, not the camera) was written to */
  head: boolean;
  /** Collections whose order or membership may have changed: written at an index, a key or their length, or replaced */
  lists: ReadonlySet<Key>;
  /** Items written into, raw object → where it was: its collection and index (place: its id) */
  items: ReadonlyMap<object, { k: Key; at: string }>;
}

const COLLECTIONS: ReadonlySet<PropertyKey> = new Set(KEYS);
/** Owners of the collections themselves (writing an index, a key or the length marks the collection, not an item) */
const LIST = Object.fromEntries(KEYS.map((k) => [k, {}])) as Record<Key, object>;
/** Owner of everything under the board's own fields */
const HEAD = {};
/** Owner of the camera: not in a snapshot */
const CAM = {};

export function tracker(raw: Raw) {
  let items = new Map<object, { k: Key; at: string }>();
  let lists = new Set<Key>();
  let head = false;
  let all = false;
  /** Bumped by every write that may add a card: what a card collection or board field write, or a new board, could change */
  let cardsRev = 0;
  /** target → its proxy and the owner it marks (an object reached under another item gets a new proxy) */
  const proxies = new WeakMap<object, { owner: object; p: object }>();
  /** proxy → target */
  const targets = new WeakMap<object, object>();
  /** an item's raw object → where it was last read from */
  const where = new WeakMap<object, { k: Key; at: string }>();
  let root: object | null = null;

  const isObj = (v: unknown): v is object => typeof v === "object" && v !== null;
  const mark = (owner: object) => {
    if (owner === HEAD) {
      head = true;
      cardsRev++;
    } else if (owner !== CAM && !items.has(owner)) {
      const w = where.get(owner);
      if (w) items.set(owner, { k: w.k, at: w.at });
      else setAll(); // can't happen: an item is reached only through its collection
    }
  };
  const addList = (k: Key) => {
    lists.add(k);
    if (k === "cards") cardsRev++;
  };
  const setAll = () => {
    all = true;
    cardsRev++;
  };
  const markRoot = (k: PropertyKey) => {
    if (COLLECTIONS.has(k)) addList(k as Key);
    else mark(k === "cam" ? CAM : HEAD);
  };

  /** A value written into the board: our proxies in it are replaced by their targets (a plain board must not keep a proxy) */
  function strip(v: unknown, seen: Set<object>): unknown {
    if (!isObj(v)) return v;
    const t = targets.get(v);
    if (t) return t;
    if (seen.has(v)) return v;
    seen.add(v);
    const o = v as Record<string, unknown>;
    for (const k of Object.keys(o)) {
      const x = o[k];
      if (isObj(x)) {
        const y = strip(x, seen);
        if (y !== x) o[k] = y;
      }
    }
    return v;
  }

  /** kind: the board, one of its collections (key = which), or anything under an item or a board field (owner = which) */
  function proxy(target: object, owner: object, kind: "root" | "list" | "item", key?: Key): object {
    const had = proxies.get(target);
    if (had && had.owner === owner) return had.p;
    const onWrite = (k: PropertyKey) => {
      if (kind === "root") markRoot(k);
      else if (kind === "list") addList(key!);
      else mark(owner);
    };
    const p = new Proxy(target, {
      get(t, k) {
        const v = Reflect.get(t, k);
        if (typeof k === "symbol" || !isObj(v)) return v;
        if (kind === "root") {
          if (COLLECTIONS.has(k)) return proxy(v, LIST[k as Key], "list", k as Key);
          return proxy(v, k === "cam" ? CAM : HEAD, "item");
        }
        if (kind === "list") {
          // an item of a collection (an array index, or a place entry): it marks itself
          if (Array.isArray(t) && !/^\d+$/.test(k)) return v;
          const r = raw(v),
            w = where.get(r);
          if (!w) where.set(r, { k: key!, at: k });
          else if (w.at !== k || w.k !== key) {
            w.k = key!;
            w.at = k;
          }
          return proxy(v, r, "item");
        }
        return proxy(v, owner, "item");
      },
      set(t, k, v) {
        onWrite(k);
        (t as Record<PropertyKey, unknown>)[k] = strip(v, new Set());
        return true;
      },
      deleteProperty(t, k) {
        onWrite(k);
        return Reflect.deleteProperty(t, k);
      },
      defineProperty(t, k, d) {
        onWrite(k);
        return Reflect.defineProperty(t, k, "value" in d ? { ...d, value: strip(d.value, new Set()) } : d);
      },
    });
    proxies.set(target, { owner, p });
    targets.set(p, target);
    return p;
  }

  return {
    /** The board `fn` gets inside a write */
    wrap(b: Board): Board {
      if (root !== b) {
        root = b;
        setAll(); // a new board object: nothing in it is what the last snapshot saw
      }
      return proxy(b, HEAD, "root") as Board;
    },
    /** Read past the shell's draft and our proxy */
    raw: (<T>(x: T): T => raw(isObj(x) ? ((targets.get(x) as T | undefined) ?? x) : x)) as Raw,
    /** Items the shell put back in place without a write (undo): where they are */
    touch(at: { k: Key; at: string; item: unknown }[]) {
      for (const x of at) if (isObj(x.item)) items.set(x.item, { k: x.k, at: x.at });
    },
    /** The shell replaced the whole board (it may keep its objects and change them in place): the next snapshot reads it all */
    touchAll() {
      setAll();
    },
    /** Changes when a card may have been added since (see cardsRev) */
    cardsRev: () => cardsRev,
    /** The marks so far, cleared for the next snapshot */
    take(): Marks {
      const m: Marks = { all, head: head || all, lists, items };
      items = new Map();
      lists = new Set();
      head = all = false;
      return m;
    },
  };
}
