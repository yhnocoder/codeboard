// A commit right after an edit: the version check of the edited file can still be running when the commit's check starts. The
// commit's check must compare with the new HEAD (it used to get the HEAD cached by the older check, so the card stayed "+ uncommitted")
import * as fs from "node:fs";
import * as path from "node:path";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { emptyBoard } from "@codeboard/core";
import { Storage } from "@codeboard/core/storage";
import { nodeFs } from "../src/nodefs";
import { BoardPanel, type BoardHost } from "../src/boards";
import { useWorkspace } from "../src/ws";
import { nodeWorkspace } from "./node-workspace";
import { card, git, startTreeSitter, stubView, tempRepo } from "./helpers";

// Holds the next `git show` until released: the edited file's check is still running when the commit lands
const gate: { armed: boolean; reached?: () => void; release?: Promise<void> } = { armed: false };
vi.mock("../src/git", async (orig) => {
  const m = await orig<typeof import("../src/git")>();
  return {
    ...m,
    showFile: async (...a: Parameters<typeof m.showFile>) => {
      if (gate.armed) {
        gate.armed = false;
        gate.reached?.();
        await gate.release;
      }
      return m.showFile(...a);
    },
  };
});

beforeAll(startTreeSitter);

describe("version re-checks of one board", () => {
  it("a check started after a commit compares with the new HEAD while an older check is still running", async () => {
    const src = (body: string) => ["def g(x):", `    return ${body}`, ""].join("\n");
    const R = tempRepo("order", { "f.py": src("x") });
    try {
      useWorkspace(nodeWorkspace(R));
      const abs = path.join(R, "f.py");
      const { card: c } = await card(abs, "g");
      const host = {
        store: new Storage(nodeFs, { dir: () => path.join(R, ".boards") }),
        staleChanged: () => undefined,
      } as unknown as BoardHost;
      const p = new BoardPanel("b", stubView().view, host);
      p.ready = true;
      p.board = { ...emptyBoard("b", "B"), cards: [c], place: { [c.id]: { x: 0, y: 0, w: 500 } } };

      fs.writeFileSync(abs, src("x + 1"));
      let release!: () => void;
      const reached = new Promise<void>((r) => {
        gate.reached = r;
      });
      gate.release = new Promise<void>((r) => {
        release = r;
      });
      gate.armed = true;
      const edited = p.refreshStale(new Set([abs])); // the saved edit: HEAD is still the pinned commit
      await reached;
      git(R, "commit", "-qam", "newer");
      const committed = p.refreshStale(); // the commit
      release();
      await Promise.all([edited, committed]);
      expect(p.stale[c.segments[0].id]?.state).toBe("changed");
    } finally {
      fs.rmSync(R, { recursive: true, force: true });
    }
  });
});
