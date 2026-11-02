import * as fs from "node:fs";
import * as path from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { dropScratchFile, scratchFile, scratchFiles } from "../src/scratchfiles";
import { HEARTBEAT_MS, STALE_MS } from "../src/scratchnames";

const dir = fs.mkdtempSync("/tmp/codeboard-scratch-");
const near = path.join(dir, "engine.py");
const put = (name: string, ageMs: number) => {
  const f = path.join(dir, name);
  fs.writeFileSync(f, "x");
  const t = new Date(Date.now() - ageMs);
  fs.utimesSync(f, t, t);
  return f;
};
// a file named "locked" cannot be deleted, as with EPERM on a file another user owns
vi.mock("node:fs", async (orig) => {
  const m = await orig<typeof import("node:fs")>();
  const rmSync: typeof m.rmSync = (p, o) => {
    if (String(p).includes("locked"))
      throw Object.assign(new Error("EPERM: operation not permitted"), { code: "EPERM" });
    m.rmSync(p, o);
  };
  return { ...m, rmSync };
});
afterEach(() => vi.useRealTimers());
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

describe("scratch files", () => {
  it("sweeps what a closed window left behind the first time a folder is used, and keeps everything else", async () => {
    const crashed = put(".codeboard-scratch-old.py", STALE_MS + 60_000);
    const otherWindow = put(".codeboard-scratch-busy.py", HEARTBEAT_MS);
    const user = put(".codeboard-notes.md", STALE_MS + 60_000);
    const f = await scratchFile("c:1", "python", near);
    expect(f).toBe(path.join(dir, ".codeboard-scratch-c_1.py"));
    expect(fs.readFileSync(f, "utf8")).toBe("");
    expect([crashed, otherWindow, user].map((x) => fs.existsSync(x))).toEqual([false, true, true]);
    expect(await scratchFile("c:1", "python", near)).toBe(f); // the same editor keeps its file
    dropScratchFile("c:1");
    expect(fs.existsSync(f)).toBe(false);
  });
  it("sweeps the rest when one stale file cannot be deleted", async () => {
    const sub = fs.mkdtempSync(path.join(dir, "sub-"));
    const locked = put(path.join(path.basename(sub), ".codeboard-scratch-locked.py"), STALE_MS + 60_000);
    const olds = ["aa", "mm", "zz"].map((n) =>
      put(path.join(path.basename(sub), `.codeboard-scratch-${n}.py`), STALE_MS + 60_000),
    );
    const f = await scratchFile("c:3", "python", path.join(sub, "engine.py"));
    expect([locked, ...olds, f].map((x) => fs.existsSync(x))).toEqual([true, false, false, false, true]);
    dropScratchFile("c:3");
  });
  it("keeps its open files fresh for other windows, and deletes them when the host stops", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
    const f = await scratchFile("c:2", "cuda-cpp", near);
    const old = new Date(Date.now() - STALE_MS);
    fs.utimesSync(f, old, old);
    vi.advanceTimersByTime(HEARTBEAT_MS);
    expect(Date.now() - fs.statSync(f).mtimeMs).toBeLessThan(STALE_MS);
    scratchFiles().dispose();
    expect(fs.existsSync(f)).toBe(false);
  });
});
