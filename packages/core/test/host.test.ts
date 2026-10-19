import { beforeAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { locateSeg, trackSeg, onlyHiddenChanged, mapLineTo, renderLine, tokenClass, rankByReceiver, parseDistInfo, parseGitLog, type Segment } from "../src";
import { initAnalysis, analyze } from "../src/analysis";

const repo = fileURLToPath(new URL("../../../examples/nano-vllm", import.meta.url));
const show = (rev: string, path: string) => execFileSync("git", ["-C", repo, "show", `${rev}:${path}`], { encoding: "utf8" });
const NEW = "bb823b3", OLD = "9e8507e";
const SCHED = "nanovllm/engine/scheduler.py";

beforeAll(() => initAnalysis());

const segAt = (rev: string, path: string, qual: string | undefined, start: number, end: number): Segment => {
  const lines = show(rev, path).split("\n");
  return {
    id: "s1", src: { kind: "repo", repo: "" }, path, lang: "python", start, end, text: lines.slice(start - 1, end),
    version: { kind: "git", commit: rev }, symbol: qual ? { qual, kind: "function" } : undefined,
  };
};

/** 拿来比的版本：commit c */
const at = (c: string) => ({ label: c, version: { kind: "git" as const, commit: c } });

describe("trackSeg", () => {
  it("is ok when nothing changed and reports changes in a symbol between commits", () => {
    const a = analyze("python", show(OLD, SCHED));
    const s = a.symbols.find((x) => x.qual === "Scheduler.schedule")!;
    const seg = segAt(OLD, SCHED, "Scheduler.schedule", s.start, s.end);
    expect(trackSeg(seg, show(OLD, SCHED).split("\n"), a.symbols, at("x")).state).toBe("ok");
    const head = show(NEW, SCHED).split("\n");
    const r = trackSeg(seg, head, analyze("python", head.join("\n")).symbols, at("bb823b3"));
    expect(r).toMatchObject({ state: "changed", hiddenOnly: false, head: "bb823b3" });
  });
  it("reports moved, pinned to the version it was found in, when only the position changed", () => {
    const text = show(NEW, SCHED).split("\n");
    const a = analyze("python", text.join("\n"));
    const s = a.symbols.find((x) => x.qual === "Scheduler.postprocess")!;
    const seg = segAt(NEW, SCHED, "Scheduler.postprocess", s.start, s.end);
    const moved = ["# one", "# two", ...text];
    expect(trackSeg(seg, moved, analyze("python", moved.join("\n")).symbols, at("h"))).toMatchObject({ state: "moved", start: s.start + 2, end: s.end + 2, version: { kind: "git", commit: "h" } });
  });
  it("tracks snippets by content and reports lost symbols", () => {
    const text = show(NEW, SCHED).split("\n");
    const seg = segAt(NEW, SCHED, undefined, 30, 33);
    expect(locateSeg(seg, ["x", ...text], [])).toEqual({ start: 31, end: 34 });
    const fn = segAt(NEW, SCHED, "Scheduler.nope", 30, 33);
    expect(trackSeg(fn, text, [], at("h")).state).toBe("lost");
  });
  it("notices when only hidden lines changed", () => {
    const old = ["a", "b", "c", "d"];
    expect(onlyHiddenChanged(old, 10, ["a", "B", "c", "d"], [[11, 11]])).toBe(true);
    expect(onlyHiddenChanged(old, 10, ["a", "b", "C", "d"], [[11, 11]])).toBe(false);
    expect(onlyHiddenChanged(old, 10, ["a", "b", "x", "c", "d"], [[11, 12]])).toBe(true);
    expect(onlyHiddenChanged(old, 10, ["a", "b", "x", "c", "d"], undefined)).toBe(false);
  });
  it("maps a line to its new position by content", () => {
    const seg = { text: ["a", "b", "c"], start: 10 };
    expect(mapLineTo(seg, 12, ["a", "new", "b", "c"], 20)).toBe(23);
    expect(mapLineTo(seg, 11, ["a", "c"], 5)).toBe(5);
  });
});

describe("renderLine", () => {
  it("wraps calls across token boundaries and escapes", () => {
    const toks = [{ text: "x = ", cls: undefined }, { text: "self", cls: "self" }, { text: ".", cls: "p" }, { text: "f<g", cls: "fn" }, { text: "()" }];
    expect(renderLine(toks, [{ col: 9, end: 12, idx: 0 }])).toBe('x = <span class="self">self</span><span class="p">.</span><span class="call" data-c="0"><span class="fn">f&lt;g</span></span>()');
    expect(renderLine([{ text: "abcdef", cls: "fn" }], [{ col: 2, end: 4, idx: 3 }])).toBe('<span class="fn">ab</span><span class="call" data-c="3"><span class="fn">cd</span></span><span class="fn">ef</span>');
  });
  it("cuts the trailing comment", () => {
    expect(renderLine([{ text: "x = 1  " }, { text: "# c", cls: "com" }], [], 7)).toBe("x = 1");
  });
  it("maps shiki variables to classes", () => {
    expect(tokenClass("var(--shiki-token-keyword)", "def")).toBe("kw");
    expect(tokenClass("var(--shiki-foreground)", "self")).toBe("self");
    expect(tokenClass("var(--shiki-foreground)", "x")).toBeUndefined();
  });
});

describe("rankByReceiver", () => {
  const cands = [
    { qual: "Scheduler.schedule", path: "nanovllm/engine/scheduler.py", line: 25 },
    { qual: "Other.schedule", path: "nanovllm/other.py", line: 3 },
  ];
  it("prefers the class named like the receiver", () => {
    expect(rankByReceiver(cands, "self.scheduler", { path: "x.py" }).best?.qual).toBe("Scheduler.schedule");
  });
  it("prefers the current class for self", () => {
    expect(rankByReceiver(cands, "self", { path: "nanovllm/other.py", selfClass: "Other" }).best?.qual).toBe("Other.schedule");
  });
  it("has no best when nothing distinguishes", () => {
    expect(rankByReceiver(cands, "obj", { path: "x.py" }).best).toBeUndefined();
  });
});

describe("small parsers", () => {
  it("parses dist-info names and git log", () => {
    expect(parseDistInfo("torch-2.5.1.dist-info")).toEqual({ name: "torch", version: "2.5.1" });
    expect(parseDistInfo("typing_extensions-4.12.2.dist-info")).toEqual({ name: "typing_extensions", version: "4.12.2" });
    expect(parseGitLog("abc1234\tfix\t2026-01-02\n\ndiff --git\n")).toEqual([{ commit: "abc1234", msg: "fix", date: "2026-01-02" }]);
  });
});
