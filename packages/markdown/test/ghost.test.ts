// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { GhostAsker, holdGhosts, type GhostQuery } from "../src/ui/ghost";

const query = (shown: string[]): GhostQuery => ({ context: () => ["before", ""], still: () => true, show: (t) => shown.push(t) });

describe("GhostAsker", () => {
  afterEach(() => { holdGhosts(false); vi.useRealTimers(); });

  it("asks after the delay and shows the answer", async () => {
    vi.useFakeTimers();
    const shown: string[] = [];
    const a = new GhostAsker(async () => " more", () => {}, 100);
    a.schedule(() => query(shown));
    await vi.advanceTimersByTimeAsync(150);
    expect(shown).toEqual([" more"]);
    a.dispose();
  });

  it("does not ask while held", async () => {
    vi.useFakeTimers();
    const complete = vi.fn(async () => " more");
    const a = new GhostAsker(complete, () => {}, 100);
    holdGhosts(true);
    a.schedule(() => query([]));
    await vi.advanceTimersByTimeAsync(150);
    expect(complete).not.toHaveBeenCalled();
    a.dispose();
  });

  it("holding clears the shown ghost and drops a pending ask", async () => {
    vi.useFakeTimers();
    const complete = vi.fn(async () => " more");
    const clear = vi.fn();
    const a = new GhostAsker(complete, clear, 100);
    a.schedule(() => query([]));
    holdGhosts(true);
    expect(clear).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(150);
    expect(complete).not.toHaveBeenCalled();
    a.dispose();
  });

  it("an answer that comes back while held is not shown", async () => {
    vi.useFakeTimers();
    let answer!: (t: string) => void;
    const shown: string[] = [];
    const a = new GhostAsker(() => new Promise<string>((r) => { answer = r; }), () => {}, 100);
    a.schedule(() => query(shown));
    await vi.advanceTimersByTimeAsync(150);
    holdGhosts(true);
    answer(" more");
    await vi.advanceTimersByTimeAsync(0);
    expect(shown).toEqual([]);
    a.dispose();
  });

  it("a disposed asker is not cleared any more", () => {
    const clear = vi.fn();
    new GhostAsker(async () => null, clear).dispose();
    holdGhosts(true);
    expect(clear).not.toHaveBeenCalled();
  });
});
