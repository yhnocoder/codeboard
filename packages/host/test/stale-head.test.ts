// A commit right after an edit: the version check of the edited file can still be running when the commit's check starts. The
// commit's check must compare with the new HEAD (it used to get the HEAD cached by the older check, so the card stayed "+ uncommitted")
import * as fs from "node:fs";
import * as path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { emptyBoard } from "@codeboard/core";
import { Storage } from "../src/storage/boards";
import { nodeFs } from "../src/storage/nodefs";
import { BoardPanel, type BoardHost } from "../src/boards";
import { nodeWorkspace } from "./node-workspace";
import { card, git, startTreeSitter, stubView, tempRepo } from "./helpers";
import { HostContext } from "../src/context";

let cx: HostContext;

// Holds the next `git show` until released: the edited file's check is still running when the commit lands
const gate: { armed: boolean; reached?: () => void; release?: Promise<void> } = { armed: false };

beforeAll(startTreeSitter);

describe("version re-checks of one board", () => {
  it("a check started after a commit compares with the new HEAD while an older check is still running", async () => {
    const src = (body: string) => ["def g(x):", `    return ${body}`, ""].join("\n");
    const R = tempRepo("order", { "f.py": src("x") });
    try {
      cx = new HostContext(nodeWorkspace(R));
      const show = cx.git.showFile;
      cx.git.showFile = async (...a) => {
        if (gate.armed) {
          gate.armed = false;
          gate.reached?.();
          await gate.release;
        }
        return show(...a);
      };
      const abs = path.join(R, "f.py");
      const { card: c } = await card(cx, abs, "g");
      const host = {
        get cx() {
          return cx;
        },
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
