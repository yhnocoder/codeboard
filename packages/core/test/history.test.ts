// The undo engine and saving on a plain board (no Solid, no DOM): snapshots, undo / redo, merged steps, syncs replayed after undo,
// drags, fresh cards, per-board histories, and the patches sent to the host
import { types } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { emptyBoard, type Board, type BoardPatch, type Card } from "../src";
import { createHistory, createSave, NOT_UNDONE, type Doc } from "../src/history";

// The self-check is on in every test (setup): a snapshot that missed a change fails the test
let warned: unknown[][] = [];
const realWarn = console.warn;
beforeEach(() => {
  warned = [];
  console.warn = (...a: unknown[]) => {
    warned.push(a);
  };
});
afterEach(() => {
  console.warn = realWarn;
  expect(warned.filter((a) => String(a[0]).includes("snapshot missed"))).toEqual([]);
});

const note = (id: string, md = ""): Card => ({ id, kind: "note", md }) as Card;

/**
 * inPlace: undo puts items back into the board's own objects, as the board's Solid store does (reconcile), instead of new ones
 */
function setup(start = emptyBoard("b1", "B1"), selfCheck = true, inPlace = false) {
  let board: Board = structuredClone(start);
  const doc: Doc = {
    read: () => board,
    write: (fn) => fn(board),
    replace: (b) => {
      board = structuredClone(b);
    },
    putItems: (ops) => {
      for (const [k, at, v] of ops) {
        if (inPlace) {
          const o = (k === "place" ? board.place[at as string] : (board[k] as unknown[])[at as number]) as object;
          for (const key of Object.keys(o)) delete (o as Record<string, unknown>)[key];
          Object.assign(o, v);
          continue;
        }
        if (k === "place") board.place[at as string] = v as Board["place"][string];
        else (board[k] as unknown[])[at as number] = v;
      }
    },
    raw: (x) => x,
  };
  const log = { changed: 0, live: 0, restored: 0, toasts: [] as string[], stacks: [false, false] };
  const h = createHistory(
    doc,
    {
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
    },
    { noteBlocks: (md) => md.split(/\n{2,}/), selfCheck },
  );
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

  it("drops a fresh question left empty: it is a sticker, not a card", () => {
    const { h, board, add } = setup();
    add("a");
    h.createFresh("q", (b) => {
      b.stickers.push({
        id: "q",
        icon: { pack: "q", name: "q" },
        at: { kind: "canvas", x: 0, y: 0, size: 28, on: { card: "a" } },
      } as Board["stickers"][number]);
    });
    h.settleFresh("q", false);
    expect(board().stickers).toEqual([]);
    expect(board().cards.map((c) => c.id)).toEqual(["a"]);
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

  it("drops a fresh card left unsettled by a board switch: settling it later puts nothing on the new board's undo stack", () => {
    const { h, board, log } = setup();
    h.createFresh("a", (b) => {
      b.cards.push(note("a"));
      b.place.a = { x: 0, y: 0, w: 320 };
    });
    h.setBoard(emptyBoard("b2", "B2"), ["b1"]);
    expect(h.isFresh("a")).toBe(false);
    h.settleFresh("a", true, (b) => {
      for (const c of b.cards) if (c.id === "a") (c as { md: string }).md = "hi";
    });
    expect(log.stacks).toEqual([false, false]);
    expect(h.undo()).toBe(false);
    expect(board().id).toBe("b2");
    expect(board().cards).toEqual([]);
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

describe("self-check", () => {
  const dangle = (b: Board) => {
    b.links.push({ id: "l1", from: { card: "a" }, to: { card: "gone" } } as Board["links"][number]);
  };
  it("warns about references to items that are gone only when it is on", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const off = setup(undefined, false);
      off.add("a");
      off.h.mutate(dangle);
      expect(warn).not.toHaveBeenCalled();
      const on = setup(undefined, true);
      on.add("a");
      on.h.mutate(dangle);
      expect(warn).toHaveBeenCalledWith("[codeboard] dangling references after a change:", expect.anything());
    } finally {
      warn.mockRestore();
    }
  });
});

describe("snapshots of the items an edit wrote to", () => {
  const code = (id: string): Card =>
    ({
      id,
      kind: "code",
      segments: [{ id: `${id}s`, path: "a.py", start: 1, end: 2, text: "x = 1\ny = 2", lang: "python" }],
    }) as unknown as Card;
  /** No proxy of the engine's left anywhere in the plain board */
  function noProxies(x: unknown, path = "board"): void {
    if (typeof x !== "object" || x === null) return;
    expect(types.isProxy(x), path).toBe(false);
    for (const [k, v] of Object.entries(x)) noProxies(v, `${path}.${k}`);
  }

  for (const inPlace of [false, true])
    it(`stays the whole board's snapshot through every kind of write${inPlace ? " (undo writing in place)" : ""}`, () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      try {
        const { h, add, board } = setup(emptyBoard("b1", "B1"), true, inPlace);
        for (const id of ["a", "b", "c", "d"]) add(id, `# ${id}`);
        const edits: ((b: Board) => void)[] = [
          (b) => {
            b.place.b.x = 7; // a field of a place
          },
          (b) => {
            (b.cards[2] as { md: string }).md = "changed"; // a field of a card
          },
          (b) => {
            b.cards.push(code("e"));
            b.place.e = { x: 1, y: 2, w: 300 };
          },
          (b) => {
            const c = b.cards.find((x) => x.id === "e") as unknown as { segments: { text: string }[] };
            c.segments[0].text = "x = 2\ny = 3"; // deep in a card
            c.segments.push({ ...c.segments[0] }); // a copy of something read through the board
          },
          (b) => {
            b.cards.reverse(); // order only
          },
          (b) => {
            const i = b.cards.findIndex((x) => x.id === "a");
            b.cards[i] = { ...b.cards[i], md: "new object" } as Card; // an item replaced
          },
          (b) => {
            b.cards = b.cards.filter((x) => x.id !== "c"); // a collection replaced
            delete b.place.c;
          },
          (b) => {
            b.place.d = { ...b.place.d, y: 99 };
          },
          (b) => {
            Object.assign(b.place.b, { w: 400, x: 1 });
          },
          (b) => {
            b.name = "renamed"; // a board field
            b.shelf = [{ id: "sh", at: 1, place: { z: { ...b.place.b } }, sections: [], links: [], stickers: [] }];
          },
          (b) => {
            b.shelf![0].place.z.x = 2; // deep in a board field
          },
          (b) => {
            b.links.push({ id: "l1", from: { card: "a" }, to: { card: "b" } });
            b.sections.push({ id: "x1", title: "S", x: 0, y: 0, w: 10, h: 10 });
          },
          (b) => {
            b.links[0].to = { card: "d" };
            b.sections[0].title = "T";
          },
        ];
        for (const fn of edits) h.mutate(fn);
        h.sync((b) => {
          b.place.a.y = 5;
        });
        const live = h.beginGesture();
        h.live((b) => {
          b.place.a.x = 50;
        });
        live();
        noProxies(board());
        for (let i = 0; i < edits.length + 1; i++) h.undo();
        for (let i = 0; i < 4; i++) h.redo();
        h.mutate((b) => {
          b.place.a.x = 3;
        });
        for (let i = 0; i < edits.length + 4; i++) h.redo() || h.undo();
        noProxies(board());
        expect(warn.mock.calls.filter((c) => String(c[0]).includes("snapshot missed"))).toEqual([]);
      } finally {
        warn.mockRestore();
      }
    });

  it("gives an edit the same object however it reached it", () => {
    const { h, add } = setup();
    add("a");
    add("b");
    h.mutate((b) => {
      b.links.push({ id: "l1", from: { card: "a" }, to: { card: "b" } });
    });
    let seen: unknown[] = [];
    h.mutate((b) => {
      const l = b.links[0];
      b.shelf = [{ id: "sh", at: 1, place: {}, sections: [], links: [b.links[0]], stickers: [] }];
      const via = b.shelf[0].links[0];
      seen = [via === l, b.links.indexOf(via), b.links.includes(b.shelf[0].links[0])];
      b.links.splice(0, 1); // shelved: under one item again
    });
    expect(seen).toEqual([true, 0, true]);
  });

  it("warns when the board changed past the engine (the self-check of the snapshot)", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const { h, add, board } = setup(emptyBoard("b1", "B1"), true);
      add("a");
      add("b");
      (board().cards[0] as { md: string }).md = "behind the engine's back";
      h.mutate((b) => {
        b.place.b.x = 1;
      });
      expect(warn.mock.calls.some((c) => String(c[0]).includes("snapshot missed a change"))).toBe(true);
    } finally {
      warn.mockRestore();
    }
  });

  it("costs what an edit changed, not the board's size (CPU time)", () => {
    const n = 1000;
    const start = emptyBoard("big", "big");
    for (let i = 0; i < n; i++) {
      start.cards.push(
        note(`n${i}`, `## Note ${i}\n\n${"Some prose about the code, with $x^2$ and a list.\n- a\n- b\n".repeat(8)}`),
      );
      start.place[`n${i}`] = { x: (i % 20) * 400, y: Math.floor(i / 20) * 500, w: 320 };
      if (i) start.links.push({ id: `l${i}`, from: { card: `n${i - 1}` }, to: { card: `n${i}` } });
    }
    const { h, board } = setup(start, false);
    const save = createSave({
      loaded: () => true,
      snap: h.snap,
      cam: () => board().cam,
      takeUndone: h.takeUndone,
      post: async () => ({ skipped: 0 }),
      toast: () => {},
      liveDelay: 10,
      resendDelay: 10,
    });
    save.flush();
    /** Least CPU time per run of `fn` over a few rounds, in µs: a collection or a compile landing in one round does not count */
    function cpu(fn: (i: number) => void, runs: number) {
      for (let i = 0; i < 20; i++) fn(i); // warm up
      let best = Number.POSITIVE_INFINITY;
      for (let r = 0; r < 5; r++) {
        const t0 = process.cpuUsage();
        for (let i = 0; i < runs; i++) fn(i);
        const t = process.cpuUsage(t0);
        best = Math.min(best, (t.user + t.system) / runs);
      }
      return best;
    }
    // one card moved and its typing, each saved the way the board saves (a patch)
    const move = cpu((i) => {
      h.mutate((b) => {
        b.place[`n${(i * 7) % n}`].x += 1;
      });
      save.flush();
    }, 200);
    const type = cpu((i) => {
      h.mutate((b) => {
        const c = b.cards[(i * 13) % n] as { md: string };
        c.md += "x";
      });
      save.flush();
    }, 200);
    // against what every edit used to cost at least: stringifying the whole board once (an edit was about 1.3× that)
    const whole = cpu(() => JSON.stringify(board()), 10);
    const msg = `${n} cards: move ${move.toFixed(0)} µs, type ${type.toFixed(0)} µs, whole board ${whole.toFixed(0)} µs`;
    expect(move / whole, msg).toBeLessThan(0.2);
    expect(type / whole, msg).toBeLessThan(0.2);
  });
});
