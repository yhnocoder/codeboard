// @vitest-environment jsdom
// The camera's flights (camTo) and glides (fling): one ends when the other starts, and whoever waits for a flight (camRest) goes on
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cam, camRest, camTo, fling, setCam } from "../../src/state/camera";

const FRAME = 16;
/** Runs animation frames until p settles (at most n) */
async function framesUntil(p: Promise<unknown>, n = 400) {
  let done = false;
  void p.then(() => (done = true));
  for (let i = 0; i < n && !done; i++) {
    vi.advanceTimersByTime(FRAME);
    await Promise.resolve();
  }
  return done;
}

beforeEach(() => {
  vi.useFakeTimers({
    toFake: ["requestAnimationFrame", "cancelAnimationFrame", "setTimeout", "clearTimeout", "performance"],
  });
  setCam(0, 0, 1);
});
afterEach(() => {
  vi.runOnlyPendingTimers();
  vi.useRealTimers();
});

describe("camera", () => {
  it("lets whoever waits for a flight go on when a fling takes over, and flies again afterwards", async () => {
    camTo(500, 0, 1);
    vi.advanceTimersByTime(FRAME * 3);
    const waited = camRest();
    fling(2000, 0);
    expect(await framesUntil(waited, 1)).toBe(true);
    vi.advanceTimersByTime(FRAME * 200);
    camTo(-300, 40, 1);
    expect(await framesUntil(camRest())).toBe(true);
    expect(cam.x).toBeCloseTo(-300, 1);
    expect(cam.y).toBeCloseTo(40, 1);
  });

  it("stops a fling when a flight starts, so the flight lands where it was sent", async () => {
    fling(4000, 4000);
    vi.advanceTimersByTime(FRAME * 2);
    camTo(100, 100, 1);
    expect(await framesUntil(camRest())).toBe(true);
    vi.advanceTimersByTime(FRAME * 60);
    expect(cam.x).toBeCloseTo(100, 1);
    expect(cam.y).toBeCloseTo(100, 1);
  });
});
