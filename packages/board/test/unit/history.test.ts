// The undo engine and saving on a plain board (no Solid, no DOM): snapshots, undo / redo, merged steps, syncs replayed after undo,
// drags, fresh cards, per-board histories, and the patches sent to the host
import { describe, expect, it } from "vitest";
import { emptyBoard, type Board, type BoardPatch, type Card } from "@codeboard/core";
import { createHistory, NOT_UNDONE, type Doc } from "../../src/state/history";
import { createSave } from "../../src/state/save";

const note = (id: string, md = ""): Card => ({ id, kind: "note", md }) as Card;

function setup(start = emptyBoard("b1", "B1")) {
  let board: Board = structuredClone(start);
  const doc: Doc = {
    read: () => board,
    write: (fn) => fn(board),
    replace: (b) => {
      board = structuredClone(b);
    },
    putItems: (ops) => {
      for (const [k, at, v] of ops) {
        if (k === "place") board.place[at as string] = v as Board["place"][string];
        else (board[k] as unknown[])[at as number] = v;
      }
    },
    raw: (x) => x,
  };
  const log = { changed: 0, live: 0, restored: 0, toasts: [] as string[], stacks: [false, false] };
  const h = createHistory(doc, {
    changed: () => {
      log.changed++;
    },
    changedLive: () => {
      log.live++;
    },
    stacks: (u, r) => {
      log.stacks = [u, r];
    },
    restored: () => {
      log.restored++;
    },
    toast: (t) => {
      log.toasts.push(t);
    },
  });
  h.setBoard(board, []);
  const add = (id: string, md = "", x = 0) =>
    h.mutate((b) => {
      b.cards.push(note(id, md));
      b.place[id] = { x, y: 0, w: 320 };
    });
  const md = (id: string) => (doc.read().cards.find((c) => c.id === id) as { md: string } | undefined)?.md;
  return { h, doc, log, add, md, board: () => doc.read() };
}

describe("undo and redo", () => {
  it("undoes and redoes a change, and a change that changes nothing is no step", () => {
    const { h, log, add, board } = setup();
    add("a");
    expect(board().cards.map((c) => c.id)).toEqual(["a"]);
    expect(log.stacks).toEqual([true, false]);
    h.mutate(() => {});
    expect(h.undo()).toBe(true);
    expect(board().cards).toEqual([]);
    expect(h.undo()).toBe(false);
    expect(h.redo()).toBe(true);
    expect(board().cards.map((c) => c.id)).toEqual(["a"]);
    expect(log.restored).toBe(2);
  });

  it("puts back only the changed items when the ids are the same", () => {
    const { h, add, board } = setup();
    add("a");
    add("b");
    const b0 = board().cards[1];
    h.mutate((b) => {
      b.place.a.x = 50;
    });
    h.undo();
    expect(board().place.a.x).toBe(0);
    expect(board().cards[1]).toBe(b0); // untouched item keeps its object
  });

  it("folds steps with the same merge key, until another change", () => {
    const { h, add, board } = setup();
    add("a");
    for (let i = 1; i <= 3; i++)
      h.mutate(
        (b) => {
          b.place.a.x = i * 10;
        },
        { merge: "nudge" },
      );
    h.mutate((b) => {
      b.place.a.y = 5;
    });
    h.mutate(
      (b) => {
        b.place.a.x = 99;
      },
      { merge: "nudge" },
    );
    h.undo();
    expect(board().place.a).toMatchObject({ x: 30, y: 5 });
    h.undo();
    expect(board().place.a).toMatchObject({ x: 30, y: 0 });
    h.undo();
    expect(board().place.a.x).toBe(0);
  });

  it("puts the board back when a change throws", () => {
    const { h, add, log, board } = setup();
    add("a");
    const ok = h.mutate((b) => {
      b.place.a.x = 7;
      throw new Error("boom");
    });
    expect(ok).toBe(false);
    expect(board().place.a.x).toBe(0);
    expect(log.toasts).toEqual(["Something went wrong; the change was undone."]);
  });

  it("runs a step's effect outside the board with undo and redo", () => {
    const { h, add } = setup();
    const ran: string[] = [];
    h.mutate(
      (b) => {
        b.cards.push(note("a"));
      },
      { fx: { undo: () => ran.push("undo"), redo: () => ran.push("redo") } },
    );
    add("b");
    h.undo();
    h.undo();
    h.redo();
    expect(ran).toEqual(["undo", "redo"]);
  });
});

describe("syncs", () => {
  it("are not undo steps and are replayed after undo", () => {
    const { h, add, md, log } = setup();
    add("a", "one");
    h.sync((b) => {
      const c = b.cards.find((x) => x.id === "a") as { md: string } | undefined;
      if (c) c.md = "synced";
    });
    add("b");
    h.undo();
    expect(md("b")).toBeUndefined();
    expect(md("a")).toBe("synced");
    h.undo(); // before "a" existed: the sync finds nothing and skips
    expect(md("a")).toBeUndefined();
    h.redo();
    expect(md("a")).toBe("synced");
    expect(log.toasts).toEqual([]);
  });

  it("says when an undone shared item was changed on another board since", () => {
    const { h, add, log } = setup();
    add("a", "one");
    h.mutate((b) => {
      (b.cards[0] as { md: string }).md = "mine";
    });
    h.sync(
      (b) => {
        (b.cards[0] as { md: string }).md = "theirs";
      },
      ["ca"],
    );
    h.undo();
    expect(log.toasts).toEqual([NOT_UNDONE]);
  });
});

describe("drags and fresh cards", () => {
  it("makes a drag one undo step, or none when nothing changed", () => {
    const { h, add, board, log } = setup();
    add("a");
    const end = h.beginGesture();
    for (let x = 1; x <= 5; x++)
      h.live((b) => {
        b.place.a.x = x;
      });
    expect(log.live).toBe(5);
    end();
    expect(board().place.a.x).toBe(5);
    h.undo();
    expect(board().place.a.x).toBe(0);
    h.redo();
    const none = h.beginGesture();
    none();
    expect(h.undo()).toBe(true);
    expect(h.undo()).toBe(true); // the drag, then the add: the empty gesture was no step
    expect(h.undo()).toBe(false);
  });

  it("makes a fresh card and its content one step; left empty, it is gone with no step", () => {
    const { h, md, board } = setup();
    h.createFresh("a", (b) => {
      b.cards.push(note("a"));
      b.place.a = { x: 0, y: 0, w: 320 };
    });
    expect(h.isFresh("a")).toBe(true);
    h.settleFresh("a", true, (b) => {
      (b.cards[0] as { md: string }).md = "hi";
    });
    expect(h.isFresh("a")).toBe(false);
    expect(md("a")).toBe("hi");
    h.undo();
    expect(board().cards).toEqual([]);
    h.createFresh("b", (b) => {
      b.cards.push(note("b"));
      b.place.b = { x: 0, y: 0, w: 320 };
    });
    h.settleFresh("b", false);
    expect(board().cards).toEqual([]);
    expect(h.undo()).toBe(false);
  });
});

describe("per-board histories", () => {
  it("keeps a board's history when it comes back unchanged, and starts over when it changed", () => {
    const { h, add, board, log } = setup();
    add("a");
    const left = structuredClone(board());
    h.setBoard(emptyBoard("b2", "B2"), ["b1"]);
    expect(log.stacks).toEqual([false, false]);
    h.setBoard(left, []);
    expect(log.stacks).toEqual([true, false]);
    h.undo();
    expect(board().cards).toEqual([]);
    h.setBoard(emptyBoard("b2", "B2"), ["b1"]);
    h.setBoard({ ...left, name: "renamed elsewhere" }, []);
    expect(log.stacks).toEqual([false, false]);
  });
});

describe("saving", () => {
  function saving() {
    const t = setup();
    const sent: { patch: BoardPatch; undo: boolean }[] = [];
    const save = createSave({
      loaded: () => true,
      snap: t.h.snap,
      cam: () => t.board().cam,
      takeUndone: t.h.takeUndone,
      post: async (patch, undo) => {
        sent.push({ patch, undo });
        return { skipped: 0 };
      },
      toast: () => {},
      liveDelay: 10,
      resendDelay: 10,
    });
    return { ...t, save, sent };
  }

  it("sends only the changed items, and the order when it changed", () => {
    const { h, add, save, sent } = saving();
    add("a");
    add("b");
    save.markSaved();
    h.mutate((b) => {
      b.place.b.x = 40;
    });
    save.flush();
    expect(sent.at(-1)?.patch).toEqual({ place: { set: { b: { x: 40, y: 0, w: 320 } } } });
    h.mutate((b) => {
      b.cards.reverse();
    });
    save.flush();
    expect(sent.at(-1)?.patch.cards).toEqual({ order: ["b", "a"] });
    h.mutate((b) => {
      b.cards.splice(0, 1);
      delete b.place.b;
    });
    save.flush();
    expect(sent.at(-1)?.patch).toMatchObject({ cards: { del: ["b"] }, place: { del: ["b"] } });
    save.flush();
    expect(sent.length).toBe(3); // nothing changed: nothing sent
  });

  it("marks the first save after an undo, and sends the whole board when nothing was sent yet", () => {
    const { h, add, save, sent } = saving();
    add("a");
    save.flush();
    expect(sent[0].patch.full).toBe(true);
    h.undo();
    save.flush();
    expect(sent[1].undo).toBe(true);
    add("b");
    save.flush();
    expect(sent[2].undo).toBe(false);
  });

  it("sends a change made in a task when the task ends", async () => {
    const { add, save, sent } = saving();
    save.markSaved();
    add("a");
    save.changed();
    save.changed();
    expect(sent.length).toBe(0);
    await Promise.resolve();
    expect(sent.length).toBe(1);
  });
});
