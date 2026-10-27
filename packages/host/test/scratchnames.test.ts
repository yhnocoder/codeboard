import { describe, expect, it } from "vitest";
import { LANG_TABLE } from "@codeboard/core";
import { HEARTBEAT_MS, STALE_MS, isScratchName, isStale, scratchName, staleScratch } from "../src/scratchnames";

const now = Date.UTC(2026, 9, 18, 12);
const fresh = now - 30_000, stale = now - STALE_MS - 1;

describe("scratch file names", () => {
  it("sanitizes the id and maps the language to an extension", () => {
    expect(scratchName("c:12/x", "python")).toBe(".codeboard-scratch-c_12_x.py");
    expect(scratchName("k", "markdown")).toBe(".codeboard-scratch-k.txt");
  });
  it.each([scratchName("c:12/x", "python"), scratchName("k", "markdown"), scratchName("a-b_c", "cuda-cpp")])("%s is a scratch name", (n) => {
    expect(isScratchName(n)).toBe(true);
  });
  // the editor's watchers skip scratch files by this name alone, also for events that arrive after the file is gone
  it("every language's scratch file has a scratch name", () => {
    for (const l of LANG_TABLE) expect(isScratchName(scratchName("c:1", l.id)), l.id).toBe(true);
  });
  it.each([".codeboard-notes.md", ".codeboard-config", ".codeboard-ref", ".codeboard-scratch-x.md", ".codeboard-scratch-.py", ".codeboard-scratch-a.b.py", ".codeboard-scratch-x.py.bak", "x.codeboard-scratch-x.py", ".codeboard-x.py"])("%s is not a scratch name", (n) => {
    expect(isScratchName(n)).toBe(false);
  });
  it("counts as stale only when older than STALE_MS, and the heartbeat runs several times within that window", () => {
    expect([isStale(fresh, now), isStale(now - STALE_MS, now), isStale(stale, now)]).toEqual([false, false, true]);
    expect(HEARTBEAT_MS * 5).toBeLessThanOrEqual(STALE_MS);
  });
});

describe("stale scratch cleanup", () => {
  it("deletes only a stale scratch file that isn't this process's own", () => {
    const entries = [
      { name: ".codeboard-scratch-x.py", mtimeMs: fresh },       // another window is editing it
      { name: ".codeboard-scratch-old.py", mtimeMs: stale },     // left behind by a crash
      { name: ".codeboard-scratch-mine.py", mtimeMs: stale },    // this process's own file
      { name: ".codeboard-notes.md", mtimeMs: stale },           // user files
      { name: ".codeboard-config", mtimeMs: stale },
      { name: ".codeboard-ref", mtimeMs: stale },
      { name: "llm_engine.py", mtimeMs: stale },
    ];
    expect(staleScratch(entries, now, (n) => n === ".codeboard-scratch-mine.py")).toEqual([".codeboard-scratch-old.py"]);
  });
});
