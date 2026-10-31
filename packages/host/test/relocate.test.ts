import * as fs from "node:fs";
import * as path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { emptyBoard, type HostToBoard } from "@codeboard/core";
import { Storage } from "@codeboard/core/storage";
import { nodeFs } from "../src/nodefs";
import { makeHandler } from "../src/handlers";
import { BoardPanel, type BoardHost } from "../src/boards";
import { resetIndex } from "../src/nameindex";
import { useWorkspace } from "../src/ws";
import { nodeWorkspace } from "./node-workspace";
import { card, git, startTreeSitter, stubView, tempRepo } from "./helpers";

beforeAll(startTreeSitter);

describe("relocate", () => {
  it("after a rename offers the function in the renamed file and re-pins the card to it at HEAD", async () => {
    const R = tempRepo("mv", {
      "engine/scheduler.py": [
        "class Scheduler:",
        "    def schedule(self):",
        "        return 1",
        "",
        "    def other(self):",
        "        return 2",
        "",
      ].join("\n"),
    });
    const offered: string[][] = [];
    const W = nodeWorkspace(R);
    useWorkspace(W);
    resetIndex();
    try {
      const { card: c } = await card(path.join(R, "engine/scheduler.py"), "Scheduler.schedule");
      git(R, "mv", "engine/scheduler.py", "engine/sched.py");
      git(R, "commit", "-qm", "rename");
      const head = git(R, "rev-parse", "HEAD");
      const { view, posted } = stubView();
      const host = { store: new Storage(nodeFs, { dir: () => path.join(R, ".boards") }) } as unknown as BoardHost;
      const p = new BoardPanel("b", view, host);
      // The board asks where the code is now in its own dialog: pick the renamed file there
      const post = view.postMessage;
      view.postMessage = (m) => {
        post(m);
        if (m.type !== "ask" || m.ask.kind !== "pick") return;
        const ds = m.ask.items.map((i) => i.description ?? "");
        offered.push(ds);
        queueMicrotask(() =>
          p.answer(
            m.id,
            ds.findIndex((d) => d.startsWith("engine/sched.py")),
          ),
        );
      };
      p.ready = true;
      p.board = { ...emptyBoard("b", "B"), cards: [c], place: { [c.id]: { x: 0, y: 0, w: 500 } } };
      await makeHandler(host)(p, { type: "relocate", card: c.id });
      const opts = offered[0] ?? [];
      expect(opts.some((d) => d.startsWith("engine/sched.py"))).toBe(true);
      expect(opts.some((d) => d.startsWith("engine/scheduler.py"))).toBe(false);
      const rs = posted.find((m) => m.type === "replaceSegment") as
        | Extract<HostToBoard, { type: "replaceSegment" }>
        | undefined;
      expect(rs?.seg.path).toBe("engine/sched.py");
      expect(rs?.seg.symbol?.qual).toBe("Scheduler.schedule");
      expect(rs?.seg.version).toEqual({ kind: "git", commit: head });
    } finally {
      resetIndex();
      fs.rmSync(R, { recursive: true, force: true });
    }
  });
});
