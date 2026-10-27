import { describe, expect, it } from "vitest";
import {
  applyRun, callName, callTree, computeFlows, emptyBoard, loadBoard, loadRun, matchRun, rpcText, startCards, walkOrder,
  type Board, type Card, type RunApply, type RunRecord,
} from "../src";

const code = (id: string, qual: string, path = "a.py", start = 1, end = 20): Card => ({
  id, kind: "code",
  segments: [{ id: `s${id}`, src: { kind: "repo", repo: "" }, path, lang: "python", start, end, text: Array(end - start + 1).fill("x"), version: { kind: "git", commit: "bb823b3" }, symbol: { qual, kind: "function" } }],
});
function board(cards: Card[]): Board {
  const b = emptyBoard("b", "b");
  cards.forEach((c, i) => { b.cards.push(c); b.place[c.id] = { x: i * 500, y: 0, w: 400 }; b.born![c.id] = i; });
  b.seq = cards.length;
  return b;
}
const call = (id: string, from: string, line: number, to: string) => ({ id, from: { card: from, seg: `s${from}`, line }, to: { card: to }, call: { name: to, col: 0 } });

describe("RPC arrows and the call graph", () => {
  it("an RPC arrow joins the call graph (same mark across), ↩ back to does not; Walkthrough stops at ↩", () => {
    const b = board([code("call", "ModelRunner.call"), code("loop", "ModelRunner.loop"), code("run", "ModelRunner.run"), code("step", "LLMEngine.step")]);
    b.links.push(
      { id: "r", from: { card: "call", seg: "scall", line: 5 }, to: { card: "loop" }, rpc: { mech: "shm", msg: "run", fan: "all" } },
      call("c", "loop", 7, "run"),
      { id: "back", from: { card: "run" }, to: { card: "step" }, rpc: { mech: "zmq" }, back: true },
    );
    const f = computeFlows(b);
    expect(f.graphs).toHaveLength(1);
    expect(f.byId.get("loop")?.label).toBe("A");
    expect(f.byId.has("step")).toBe(false);
    expect(walkOrder(b, "call")).toEqual(["call", "loop", "run"]);
    // the board loads back with the new fields
    expect(loadBoard(structuredClone(b)).links[0].rpc).toEqual({ mech: "shm", msg: "run", fan: "all" });
  });

  it("rpcText: mechanism · message · fan-out", () => {
    expect(rpcText({ mech: "shm", msg: "run" })).toBe('RPC · shm · "run"');
    expect(rpcText({ mech: "custom", custom: "NCCL p2p", fan: "all" })).toBe("RPC · NCCL p2p · one → all ranks");
    expect(rpcText({ mech: "zmq", msg: "BatchStrOutput" })).toBe('RPC · zmq · "BatchStrOutput"');
  });
});

describe("Start cards and the call tree", () => {
  it("Start cards in creation order; Walkthrough order skips visited cards", () => {
    const b = board([code("a", "A.a"), code("b", "B.b"), code("c", "C.c")]);
    b.place.c.start = true; b.place.a.start = true;
    expect(startCards(b)).toEqual(["a", "c"]);
  });

  it("call tree: indent by depth, a card called twice shows twice and the second is marked again; cycles stop", () => {
    const b = board([code("step", "step"), code("sched", "schedule"), code("alloc", "allocate"), code("call", "call")]);
    b.links.push(call("1", "step", 3, "sched"), call("2", "sched", 4, "alloc"), call("3", "step", 6, "call"), call("4", "call", 2, "alloc"), call("5", "alloc", 9, "step"));
    const rows = callTree(computeFlows(b), ["step"]);
    expect(rows.map((r) => `${"  ".repeat(r.depth)}${r.card}${r.again ? " ↑" : ""}`)).toEqual([
      "step", "  sched", "    alloc", "      step ↑", "  call", "    alloc ↑",
    ]);
  });
});

describe("run records", () => {
  const W = "/ws";
  const rec: RunRecord = {
    version: 1, id: "r1", entry: "run.py 2", cwd: W, commit: "9f3e2a1aa", at: 1000, ms: 20, exit: 0, scope: [W], pkgs: [],
    calls: [
      { from: { file: `${W}/engine.py`, line: 11 }, to: { file: `${W}/scheduler.py`, line: 24, qual: "Scheduler.schedule" }, count: 2, samples: [{ n: 1, args: [] }, { n: 2, args: [] }] },
      { from: { file: `${W}/engine.py`, line: 12 }, to: { file: `${W}/model_runner.py`, line: 8, qual: "ModelRunner.call" }, count: 2, samples: [{ n: 1, args: [["method_name", "'run'"], ["args", "tuple · len 2"]] }, { n: 2, args: [["method_name", "'run'"], ["args", "tuple · len 2"]] }] },
      { from: { file: `${W}/model_runner.py`, line: 10 }, to: { file: `${W}/model_runner.py`, line: 16, qual: "ModelRunner.run" }, count: 2, samples: [{ n: 1, args: [["seqs", "list · len 2"], ["is_prefill", "True"]] }] },
    ],
  };
  const repo = { kind: "repo" as const, repo: "" };
  const locs: RunApply["locs"] = Object.fromEntries(["engine.py", "scheduler.py", "model_runner.py"].map((f) => [`${W}/${f}`, { src: repo, path: f, hp: f }]));
  const mk = () => {
    const b = board([code("step", "LLMEngine.step", "engine.py", 10, 14), code("sched", "Scheduler.schedule", "scheduler.py", 24, 32), code("mr", "ModelRunner.call", "model_runner.py", 8, 10), code("run", "ModelRunner.run", "model_runner.py", 16, 18)]);
    b.links.push(call("l1", "step", 11, "sched"), { ...call("l2", "step", 12, "mr"), call: { name: "call", col: 0, ev: { kind: "manual" as const, via: "registry" } } });
    return b;
  };

  it("validates the format", () => {
    expect(loadRun(structuredClone(rec)).id).toBe("r1");
    expect(() => loadRun({ ...rec, calls: [{ from: { file: "x" } }] })).toThrow(/Invalid run record/);
    expect(() => loadRun({ ...rec, version: 2 })).toThrow();
  });

  it("matches Call arrows by calling line and callee; the rest are misses with the calling card when it is on the board", () => {
    const b = mk();
    const m = matchRun(b, { run: rec, locs });
    expect(m.hits).toEqual([{ link: "l1", call: 0 }, { link: "l2", call: 1 }]);
    expect(m.misses).toEqual([2]);
    expect(m.callers[2]).toEqual({ card: "mr", seg: "smr" });
  });

  it("applies observed evidence: count, command, commit, samples; a manual arrow keeps base manual", () => {
    const b = mk();
    const a = { run: rec, locs };
    expect(applyRun(b, a, matchRun(b, a))).toBe(2);
    const [l1, l2] = b.links;
    expect(l1.call?.ev).toMatchObject({ kind: "observed", cmd: "run.py 2", count: 2, commit: "9f3e2a1aa", run: "r1", at: 1000 });
    expect(l1.call?.ev?.base).toBeUndefined();
    expect(l2.call?.ev).toMatchObject({ kind: "observed", base: "manual", via: "registry" });
    expect(l2.call?.seen?.[0].args[0]).toEqual(["method_name", "'run'"]);
    expect(() => loadBoard(structuredClone(b))).not.toThrow();
  });

  it("does not match an arrow whose target card is another function in the same file", () => {
    const b = mk();
    b.links.push(call("l3", "mr", 10, "sched"));
    const m = matchRun(b, { run: rec, locs });
    expect(m.hits.some((h) => h.link === "l3")).toBe(false);
  });

  it("callName: the name a call site uses", () => {
    expect(callName("Scheduler.schedule")).toBe("schedule");
    expect(callName("Sequence.__init__")).toBe("Sequence");
  });
});
