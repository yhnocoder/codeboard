// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GhostAsker, createGhostHold, type GhostHold, type GhostQuery } from "../src/ui/ghost";

const query = (shown: string[]): GhostQuery => ({
  context: () => ["before", ""],
  still: () => true,
  show: (t) => shown.push(t),
});

describe("GhostAsker", () => {
  let hold: GhostHold;
  beforeEach(() => {
    hold = createGhostHold();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("asks after the delay and shows the answer", async () => {
    vi.useFakeTimers();
    const shown: string[] = [];
    const a = new GhostAsker(
      async () => " more",
      () => {},
      hold,
      100,
    );
    a.schedule(() => query(shown));
    await vi.advanceTimersByTimeAsync(150);
    expect(shown).toEqual([" more"]);
    a.dispose();
  });

  it("does not ask while held", async () => {
    vi.useFakeTimers();
    const complete = vi.fn(async () => " more");
    const a = new GhostAsker(complete, () => {}, hold, 100);
    hold.hold(true);
    a.schedule(() => query([]));
    await vi.advanceTimersByTimeAsync(150);
    expect(complete).not.toHaveBeenCalled();
    a.dispose();
  });

  it("holding clears the shown ghost and drops a pending ask", async () => {
    vi.useFakeTimers();
    const complete = vi.fn(async () => " more");
    const clear = vi.fn();
    const a = new GhostAsker(complete, clear, hold, 100);
    a.schedule(() => query([]));
    hold.hold(true);
    expect(clear).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(150);
    expect(complete).not.toHaveBeenCalled();
    a.dispose();
  });

  it("an answer that comes back while held is not shown", async () => {
    vi.useFakeTimers();
    let answer!: (t: string) => void;
    const shown: string[] = [];
    const a = new GhostAsker(
      () =>
        new Promise<string>((r) => {
          answer = r;
        }),
      () => {},
      hold,
      100,
    );
    a.schedule(() => query(shown));
    await vi.advanceTimersByTimeAsync(150);
    hold.hold(true);
    answer(" more");
    await vi.advanceTimersByTimeAsync(0);
    expect(shown).toEqual([]);
    a.dispose();
  });

  it("a disposed asker is not cleared any more", () => {
    const clear = vi.fn();
    new GhostAsker(async () => null, clear, hold).dispose();
    hold.hold(true);
    expect(clear).not.toHaveBeenCalled();
  });

  it("holding one page's hold leaves askers on another alone", () => {
    const clear = vi.fn();
    const a = new GhostAsker(async () => null, clear, createGhostHold());
    hold.hold(true);
    expect(clear).not.toHaveBeenCalled();
    a.dispose();
  });
});
