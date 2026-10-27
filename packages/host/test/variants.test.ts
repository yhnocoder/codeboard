import * as fs from "node:fs";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { addVariant as addV, emptyBoard, switchVariant, type Board, type CodeCard, type Segment } from "@codeboard/core";
import { addVariant, syncVariants, variantSources } from "../src/variants";
import { staleFor, staleSegments } from "../src/versions";
import { forgetHeads } from "../src/git";
import { useWorkspace } from "../src/ws";
import { nodeWorkspace } from "./node-workspace";
import { card, git, startTreeSitter } from "./helpers";

const uncommitted = (v: unknown) => (v as { uncommitted?: boolean }).uncommitted;

describe("variants", () => {
  const FIX = fs.mkdtempSync("/tmp/codeboard-var-");
  const R = path.join(FIX, "vllm"), WT = path.join(FIX, "vllm-exp");
  const F = ["import torch", "", "", "class RejectionSampler:", "    def forward(self, draft, target, k):", "        accepted = draft < target", "        first = accepted.int().argmax(dim=-1)", "        out[:, first + 1:] = -1", "        return out", "", "    def other(self):", "        return 1", ""];
  const MINE = F.slice(); MINE.splice(6, 1, "        first = (~accepted).int().argmax(dim=-1)", "        first[accepted.all(-1)] = k");
  let base: string, c: CodeCard, seg: Segment;
  beforeAll(async () => {
    await startTreeSitter();
    fs.mkdirSync(R);
    fs.writeFileSync(path.join(R, "sampler.py"), F.join("\n"));
    git(R, "init", "-q", "-b", "main"); git(R, "add", "-A"); git(R, "commit", "-qm", "base");
    base = git(R, "rev-parse", "HEAD");
    git(R, "worktree", "add", "-q", WT, "-b", "exp-overlap");
    fs.writeFileSync(path.join(WT, "sampler.py"), MINE.join("\n"));
    git(WT, "commit", "-qam", "fix all-accepted rows");
    useWorkspace(nodeWorkspace(R));
    forgetHeads();
    ({ card: c, seg } = await card(path.join(R, "sampler.py"), "RejectionSampler.forward"));
  });
  afterAll(() => { git(R, "worktree", "remove", "--force", WT); fs.rmSync(FIX, { recursive: true, force: true }); forgetHeads(); });

  let wt: Awaited<ReturnType<typeof addVariant>>, br: Awaited<ReturnType<typeof addVariant>>;
  const b: Board = emptyBoard("bv", "variants");
  const sent = new Map<string, string>();
  const ss = () => staleSegments(b);

  it("starts from a card pinned to main", () => {
    expect(seg.version).toEqual({ kind: "git", commit: base });
  });
  it("lists the other worktree (git worktree list) and local branches", async () => {
    const src = await variantSources(seg);
    expect(src.worktrees.map((w) => ({ dir: w.dir, branch: w.branch, label: w.label }))).toEqual([{ dir: WT, branch: "exp-overlap", label: "exp-overlap · ../vllm-exp" }]);
    expect(src.branches).toContain("exp-overlap");
    expect(src.current).toBe("main");
  });
  it("reads a worktree variant from the other worktree's file, with views for the switch", async () => {
    wt = await addVariant([seg], { kind: "wt", dir: WT, branch: "exp-overlap" });
    expect(wt?.name).toBe("vllm-exp");
    expect(wt?.segs[0].src.kind).toBe("external");
    expect(wt?.segs[0].text).toContain("        first[accepted.all(-1)] = k");
    expect(uncommitted(wt?.segs[0].version)).toBeFalsy();
    expect(Object.keys(wt!.views)).toHaveLength(1);
    expect(wt!.views[seg.id].html).toHaveLength(wt!.segs[0].text.length);
  });
  it("reads a branch variant from the branch tip", async () => {
    br = await addVariant([seg], { kind: "ref", ref: "exp-overlap" });
    expect(br?.segs[0].text).toHaveLength(MINE.slice(4, 10).length);
    expect(br?.segs[0].version).toEqual({ kind: "git", commit: git(R, "rev-parse", "exp-overlap") });
  });
  it("finds a file variant by function name in the copied file", async () => {
    const CP = path.join(FIX, "mla_v2_stage3.py");
    fs.writeFileSync(CP, ["# copied", "BLOCK_N = 64", "", ...MINE].join("\n"));
    const fv = await addVariant([seg], { kind: "file", abs: CP });
    expect(fv?.name).toBe("mla_v2_stage3.py");
    expect(fv?.segs[0].start).toBe(seg.start + 3);
    expect(fv?.segs[0].version.kind).toBe("hash");
  });
  it("includes uncommitted changes in a working-tree variant", async () => {
    fs.writeFileSync(path.join(R, "sampler.py"), F.join("\n").replace("return out", "return out  # wip"));
    const wk = await addVariant([seg], { kind: "worktree" });
    expect(wk?.segs[0].text.some((l) => l.includes("# wip"))).toBe(true);
    expect(uncommitted(wk?.segs[0].version)).toBe(true);
    fs.writeFileSync(path.join(R, "sampler.py"), F.join("\n"));
  });
  it("gives a clear error for an unknown branch", async () => {
    await expect(addVariant([seg], { kind: "ref", ref: "nope" })).rejects.toThrow(/not in/);
  });
  it("syncs: nothing changed yet, upstream latest = main; nothing sent the second time", async () => {
    b.cards.push(c); b.place[c.id] = { x: 0, y: 0, w: 500 };
    addV(b, c.id, { id: "vw", name: wt!.name, from: wt!.from, segs: wt!.segs });
    addV(b, c.id, { id: "vb", name: br!.name, from: br!.from, segs: br!.segs });
    switchVariant(b, c.id, "vw");
    const r = (await syncVariants(b, sent))[c.id];
    expect(r?.segs).toBeUndefined();
    expect(r?.latest?.label).toBe(`main ${base.slice(0, 7)}`);
    expect(r?.latest?.segs[0].text).toEqual(seg.text);
    expect(await syncVariants(b, sent)).toEqual({});
  });
  it("refreshes the worktree variant when the other worktree saves (views keyed by variant)", async () => {
    fs.writeFileSync(path.join(WT, "sampler.py"), MINE.join("\n").replace("return out", "return out  # tuned"));
    const r = (await syncVariants(b, sent))[c.id];
    expect(r?.segs?.vw?.[0].text.some((l) => l.includes("# tuned"))).toBe(true);
    expect(uncommitted(r?.segs?.vw?.[0].version)).toBe(true);
    expect(r?.views?.[`${seg.id}@vw`]).toBeTruthy();
    fs.writeFileSync(path.join(WT, "sampler.py"), MINE.join("\n"));
    await syncVariants(b, sent);
  });
  it("tells the branch is behind main, and compares upstream staleness with main", async () => {
    // main gets a commit with lines above the function
    fs.writeFileSync(path.join(R, "sampler.py"), ["import torch", "import math", "", "SCALE = 1", ...F.slice(1)].join("\n"));
    git(R, "commit", "-qam", "upstream: imports");
    const r = (await syncVariants(b, sent))[c.id];
    expect(r?.behind?.vb).toBe(1);
    expect(r?.latest?.segs[0].start).toBe(seg.start + 3);
    const s = ss();
    expect(s.up.has(seg.id)).toBe(true);
    expect((await staleFor(s.segs, s.up))[seg.id]?.state).toBe("moved");
  });
  it("re-anchors the variants by function name after a rebase", async () => {
    git(WT, "rebase", "-q", "main");
    forgetHeads();
    const r = (await syncVariants(b, sent))[c.id];
    expect(r?.rebased).toEqual(expect.arrayContaining(["vb", "vw"]));
    expect(r?.segs?.vb?.[0].start).toBe(seg.start + 3);
    expect(r?.segs?.vb?.[0].text).toContain("        first[accepted.all(-1)] = k");
  });
  it("offers to turn back into a normal card once merged into main, and shows main's new version", async () => {
    const main2 = git(R, "rev-parse", "HEAD");
    git(R, "merge", "-q", "--ff-only", "exp-overlap");
    forgetHeads();
    const r = (await syncVariants(b, sent))[c.id];
    const tip = git(R, "rev-parse", "HEAD");
    expect(tip).not.toBe(main2);
    expect(r?.merged?.vb?.into).toBe(`main ${tip.slice(0, 7)}`);
    expect(r?.merged?.vw?.tip).toBe(tip);
    const s = ss();
    expect((await staleFor(s.segs, s.up))[seg.id]).toMatchObject({ state: "changed", head: `main ${tip.slice(0, 7)}` });
  });
});

describe("variants in a submodule", () => {
  const FIX = fs.mkdtempSync("/tmp/codeboard-submod-");
  const LIB = path.join(FIX, "lib-src"), SUP = path.join(FIX, "super"), SUB = path.join(SUP, "examples/lib");
  let seg: Segment;
  beforeAll(async () => {
    await startTreeSitter();
    fs.mkdirSync(LIB); fs.mkdirSync(SUP);
    fs.writeFileSync(path.join(LIB, "m.py"), "def f():\n    return 1\n");
    git(LIB, "init", "-q", "-b", "main"); git(LIB, "add", "-A"); git(LIB, "commit", "-qm", "lib");
    git(SUP, "init", "-q", "-b", "main"); git(SUP, "submodule", "add", "-q", LIB, "examples/lib"); git(SUP, "commit", "-qm", "sub");
    useWorkspace(nodeWorkspace(SUP));
    forgetHeads();
    ({ seg } = await card(path.join(SUB, "m.py"), "f"));
  });
  afterAll(() => fs.rmSync(FIX, { recursive: true, force: true }));

  it("doesn't count the submodule's own checkout (reported as .git/modules/…) as another worktree", async () => {
    expect((await variantSources(seg)).worktrees).toEqual([]);
  });
  it("lists a real extra worktree of the submodule once, branch first, short path", async () => {
    const EXP = path.join(SUP, "examples/lib-exp");
    git(SUB, "worktree", "add", "-q", EXP, "-b", "exp");
    expect((await variantSources(seg)).worktrees.map((w) => ({ dir: w.dir, label: w.label }))).toEqual([{ dir: EXP, label: "exp · ../lib-exp" }]);
  });
});
