// @vitest-environment happy-dom
// A deleted card's fade-out copy is removed when its animation is over, at whatever speed animations run (the slow-motion setting
// sets --t on the root; the CSS durations are multiplied by it)
import { afterEach, describe, expect, it, vi } from "vitest";
import { ghostOut } from "../../src/state/ghost";
import { GHOST_OUT } from "../../src/state/timing";

function cardOnBoard() {
  document.body.innerHTML = `<div class="world"><div class="card" data-id="c1">x</div></div>`;
}
const ghosts = () => document.querySelectorAll(".ghost-out").length;

afterEach(() => { vi.useRealTimers(); document.documentElement.style.removeProperty("--t"); });

describe("ghostOut", () => {
  it("removes the copy once the fade-out is over", () => {
    vi.useFakeTimers();
    cardOnBoard();
    ghostOut(["c1"]);
    expect(ghosts()).toBe(1);
    vi.advanceTimersByTime(GHOST_OUT + 100);
    expect(ghosts()).toBe(0);
  });
  it("keeps it for the whole slowed-down fade-out", () => {
    vi.useFakeTimers();
    document.documentElement.style.setProperty("--t", "4");
    cardOnBoard();
    ghostOut(["c1"]);
    vi.advanceTimersByTime(GHOST_OUT * 4 - 10);
    expect(ghosts()).toBe(1);
    vi.advanceTimersByTime(100);
    expect(ghosts()).toBe(0);
  });
});
