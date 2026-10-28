// Version checks of one board end in the order they started: the result of an older check that ends late must not replace a newer
// one (the release shots' flake: a commit's "New version" overwritten by the edited file's "+ uncommitted")
import { describe, expect, it, vi } from "vitest";
import { emptyBoard, type CodeCard, type Stale } from "@codeboard/core";
import { BoardPanel, type BoardHost } from "../src/boards";
import { stubView } from "./helpers";

const calls: { resolve: (st: Record<string, Stale>) => void }[] = [];
vi.mock("../src/versions", async (orig) => ({
  ...(await orig<typeof import("../src/versions")>()),
  staleFor: () => new Promise<Record<string, Stale>>((resolve) => { calls.push({ resolve }); }),
}));

const seg = { id: "s1", src: { kind: "free" }, path: "f.py", lang: "python", start: 1, end: 2, text: ["def g(x):", "    return x"], version: { kind: "hash", hash: "h" } };
const c = { id: "c1", kind: "code", segments: [seg] } as unknown as CodeCard;
const turn = () => new Promise((r) => setImmediate(r));

describe("version checks of one board", () => {
  it("end in the order they started, so the newer result stays", async () => {
    const p = new BoardPanel("b", stubView().view, { staleChanged: () => undefined } as unknown as BoardHost);
    p.ready = true;
    p.board = { ...emptyBoard("b", "B"), cards: [c], place: { c1: { x: 0, y: 0, w: 500 } } };
    const older = p.refreshStale(new Set(["f.py"])), newer = p.refreshStale();
    await turn();
    // The newer check's own result comes first wherever it has already started; the older one's last
    calls[1]?.resolve({ s1: { state: "changed" } as Stale });
    calls[0].resolve({ s1: { state: "uncommitted" } });
    await older;
    await turn();
    calls[1].resolve({ s1: { state: "changed" } as Stale });
    await newer;
    expect(p.stale.s1?.state).toBe("changed");
  });
});
