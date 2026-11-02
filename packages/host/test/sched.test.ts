import { afterEach, describe, expect, it, vi } from "vitest";
import { HOLD_MAX, Prio, Scheduler } from "../src/sched";

const gate = () => {
  let open!: () => void;
  const p = new Promise<void>((r) => (open = r));
  return { p, open };
};
const settled = async (p: Promise<unknown>) => {
  let done = false;
  void p.then(() => (done = true));
  await vi.advanceTimersByTimeAsync(0);
  return done;
};

afterEach(() => {
  vi.useRealTimers();
});

describe("scheduler", () => {
  it("holds lower priorities back while higher ones run, and not the other way round", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const s = new Scheduler();
    const click = gate();
    const run = s.run(Prio.Click, () => click.p);
    expect(await settled(s.clear(Prio.Hover))).toBe(false);
    expect(await settled(s.clear(Prio.Index))).toBe(false);
    expect(await settled(s.clear(Prio.Click))).toBe(true);
    const idx = gate();
    const indexing = s.run(Prio.Index, () => idx.p);
    expect(await settled(s.clear(Prio.Warm))).toBe(false); // the click, not the index
    click.open();
    await run;
    expect(await settled(s.clear(Prio.Warm))).toBe(true);
    idx.open();
    await indexing;
  });

  it("holds them at most HOLD_MAX for work that never finishes; new work holds them again", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const s = new Scheduler();
    void s.run(Prio.Click, () => new Promise<void>(() => {}));
    const waiting = s.clear(Prio.Index);
    await vi.advanceTimersByTimeAsync(HOLD_MAX - 1);
    expect(await settled(waiting)).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await settled(waiting)).toBe(true);
    const next = gate();
    const run = s.run(Prio.Click, () => next.p);
    expect(await settled(s.clear(Prio.Index))).toBe(false);
    next.open();
    await run;
    expect(await settled(s.clear(Prio.Index))).toBe(true);
  });

  it("runs a lane's jobs a few at a time, keeping only the newest waiting ones", async () => {
    const s = new Scheduler();
    const lane = s.lane(Prio.Hover, 2, 2);
    const gates = Array.from({ length: 6 }, gate);
    const started: number[] = [];
    gates.forEach((g, i) =>
      lane(async () => {
        started.push(i);
        await g.p;
      }),
    );
    expect(started).toEqual([0, 1]);
    expect(s.idle(Prio.Hover)).toBe(false);
    gates[0].open();
    gates[1].open();
    await vi.waitFor(() => expect(started).toEqual([0, 1, 5, 4]));
    gates[4].open();
    gates[5].open();
    await vi.waitFor(() => expect(s.idle(Prio.Hover)).toBe(true));
    expect(started).toEqual([0, 1, 5, 4]); // 2 and 3 were dropped
  });
});
