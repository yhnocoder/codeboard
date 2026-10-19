import { describe, expect, it } from "vitest";
import { trimLru } from "../../src/state/lru";

describe("trimLru (per-board undo histories)", () => {
  const m = (...ks: string[]) => new Map(ks.map((k) => [k, k]));
  it("keeps the newest ones beyond the kept keys", () => {
    const h = m("a", "b", "c", "d", "e", "f");
    trimLru(h, new Set(), 4);
    expect([...h.keys()]).toEqual(["c", "d", "e", "f"]);
  });
  it("never drops kept keys (the breadcrumb) and does not count them", () => {
    const h = m("root", "a", "b", "mid", "c", "d", "e");
    trimLru(h, new Set(["root", "mid"]), 2);
    expect([...h.keys()]).toEqual(["root", "mid", "d", "e"]);
  });
  it("does nothing under the cap", () => {
    const h = m("a", "b");
    trimLru(h, new Set(["a"]), 4);
    expect([...h.keys()]).toEqual(["a", "b"]);
  });
});
