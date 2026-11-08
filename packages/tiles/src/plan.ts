// Which boards to draw, and the index.json the phone app reads: one entry per board, naming the zip of its tiles. A board whose
// picture hash is the one the previous index has keeps that index's zip (the release still holds it) and is not drawn again
import type { BoardMeta } from "@codeboard/core";

export type IndexEntry = {
  id: string;
  name: string;
  cards: number;
  subs?: string[];
  hash: string;
  /** The zip of its tiles, in the same release */
  asset: string;
  size: number;
};
export type Index = {
  branch: string;
  commit: string;
  /** The CodeBoard commit that built it (for the record: it does not decide what is drawn again) */
  codeboard: string;
  built: string;
  boards: IndexEntry[];
};
export type Planned = Omit<IndexEntry, "asset" | "size">;
export type Drawn = { asset: string; size: number };

export const zipName = (id: string, hash: string) => `${id}-${hash}.zip`;

/** The boards to draw (in the listing's order) and, for the others, the zip the previous index names */
export function plan(boards: Planned[], prev: Index | null): { todo: Planned[]; kept: Map<string, Drawn> } {
  const before = new Map((prev?.boards ?? []).map((b) => [b.id, b]));
  const kept = new Map<string, Drawn>();
  const todo: Planned[] = [];
  for (const b of boards) {
    const p = before.get(b.id);
    if (p && p.hash === b.hash && p.asset) kept.set(b.id, { asset: p.asset, size: p.size });
    else todo.push(b);
  }
  return { todo, kept };
}

/** A board's entry before it is drawn */
export const planned = (m: BoardMeta, hash: string): Planned => ({
  id: m.id,
  name: m.name,
  cards: m.cards,
  subs: m.subs,
  hash,
});

/** The index: every board, each with the zip just drawn or the one kept */
export function makeIndex(
  boards: Planned[],
  zips: Map<string, Drawn>,
  o: { branch: string; commit: string; codeboard: string; built: Date },
): Index {
  return {
    branch: o.branch,
    commit: o.commit,
    codeboard: o.codeboard,
    built: o.built.toISOString(),
    boards: boards.map((b) => {
      const z = zips.get(b.id);
      if (!z) throw new Error(`no tiles for board ${b.id}`);
      return { ...b, ...z };
    }),
  };
}
