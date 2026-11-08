// @vitest-environment jsdom
// The undo engine's snapshots on the board's own Solid store: an edit stringifies only the items it wrote to (core history/track.ts),
// so the store's drafts, its in-place reconcile on undo and its unwrapping must all leave the marks right. The engine's self-check
// (an incremental snapshot against a whole one) is on: a missed change warns
import { afterAll, describe, expect, it, vi } from "vitest";
import { unwrap } from "solid-js/store";
import { types } from "node:util";
import { DEFAULT_SETTINGS, emptyBoard, removeCards, type Board, type Card, type HostToBoard } from "@codeboard/core";
import { state } from "../../src/state/store";
import { checkEdits, flushSave, mutate, redo, sync, undo } from "../../src/state/changes";
import { fromHost, sent } from "./host";

const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
afterAll(() => warn.mockRestore());
checkEdits(true);

const note = (id: string, md: string): Card => ({ id, kind: "note", md, look: "note" }) as Card;
function init(): HostToBoard {
  const board = emptyBoard("s", "s");
  for (const id of ["a", "b", "c", "d"]) {
    board.cards.push(note(id, `# ${id}`));
    board.place[id] = { x: 0, y: 0, w: 320 };
  }
  return {
    type: "init",
    board,
    boards: [{ id: "s", name: "s", cards: 4 }],
    views: {},
    stale: {},
    host: { assetBase: "", target: true, settings: DEFAULT_SETTINGS },
  };
}
function noProxies(x: unknown, path = "board"): void {
  if (typeof x !== "object" || x === null) return;
  expect(types.isProxy(x), path).toBe(false);
  for (const [k, v] of Object.entries(x)) noProxies(v, `${path}.${k}`);
}
const missed = () => warn.mock.calls.filter((c) => /snapshot missed|dangling/.test(String(c[0])));

describe("snapshots on the board's store", () => {
  it("follow every kind of write, undo and redo, and leave no proxy of the engine in the store", () => {
    fromHost(init());
    const edits: ((b: Board) => void)[] = [
      (b) => {
        b.place.b.x = 7;
      },
      (b) => {
        (b.cards[2] as { md: string }).md = "changed";
      },
      (b) => {
        b.cards.push(note("e", "new"));
        b.place.e = { x: 1, y: 2, w: 300 };
      },
      (b) => {
        b.cards.reverse();
      },
      (b) => {
        const i = b.cards.findIndex((x) => x.id === "a");
        b.cards[i] = { ...b.cards[i], md: "new object" } as Card;
      },
      (b) => removeCards(b, ["c"]),
      (b) => {
        Object.assign(b.place.b, { w: 400, x: 1 });
        b.name = "renamed";
      },
      (b) => {
        b.links.push({ id: "l1", from: { card: "a" }, to: { card: "b" } });
      },
      (b) => {
        b.links[0].to = { card: "d" };
      },
    ];
    for (const fn of edits) mutate(fn);
    sync((b) => {
      b.place.a.y = 5;
    });
    noProxies(unwrap(state.board));
    for (let i = 0; i < edits.length + 1; i++) undo();
    expect(unwrap(state.board).cards.map((c) => c.id)).toEqual(["a", "b", "c", "d"]);
    for (let i = 0; i < 5; i++) redo();
    mutate((b) => {
      b.place.a.x = 3;
    });
    undo();
    redo();
    noProxies(unwrap(state.board));
    expect(missed()).toEqual([]);
  });

  it("saves only the item an edit wrote to", () => {
    fromHost(init());
    mutate((b) => {
      b.place.a.x = 1; // the first edit numbers the host's cards (born): a board field
    });
    flushSave();
    const n = sent.length;
    mutate((b) => {
      b.place.c.x = 42;
    });
    flushSave();
    const p = sent.slice(n).find((m) => m.type === "patch") as { patch: unknown } | undefined;
    expect(JSON.parse(JSON.stringify(p?.patch))).toEqual({ place: { set: { c: { x: 42, y: 0, w: 320 } } } });
    expect(missed()).toEqual([]);
  });

  it("stringifies only what an edit wrote to (the self-check off, as users run it)", () => {
    const b = init();
    if (b.type !== "init") throw new Error("init");
    for (let i = 0; i < 200; i++) {
      b.board.cards.push(note(`m${i}`, `# ${i}`));
      b.board.place[`m${i}`] = { x: i, y: 0, w: 320 };
    }
    fromHost(b);
    mutate((x) => {
      x.place.a.x = 1; // numbers the host's cards (born)
    });
    flushSave();
    checkEdits(false);
    const str = vi.spyOn(JSON, "stringify");
    try {
      mutate((x) => {
        x.place.m7.x = 9;
        (x.cards[20] as { md: string }).md = "typed";
      });
      flushSave();
      // the place, the card, and nothing else of the 204 cards and places
      expect(str.mock.calls.length).toBeLessThan(6);
    } finally {
      str.mockRestore();
      checkEdits(true);
    }
    expect(missed()).toEqual([]);
  });
});
