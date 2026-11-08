import { describe, expect, it } from "vitest";
import { themes } from "../../themes.mjs";

describe("themes.json from the board's stylesheets", () => {
  const t = themes() as Record<string, { light: Record<string, unknown>; dark: Record<string, unknown> }>;
  it("has every look, light and dark, with Warm Ink's tokens resolved", () => {
    expect(Object.keys(t)).toEqual(expect.arrayContaining(["warm-ink", "graphite", "ink-wash", "city"]));
    const w = t["warm-ink"];
    expect(w.light.ink).toBe("#211f1bff");
    expect(w.dark.ink).toBe("#ece8e0ff");
    expect(w.light["k-kw"]).toBe("#9a3f22ff");
    expect(w.light["r-card"]).toBe(12.5);
    // rgba, color-mix with transparent and with the look's surface, a shadow list's colour
    expect(w.light.hair).toBe("#3c2d1429");
    expect(w.light["sect-fill"]).toMatch(/^#211f1b0[56]$/);
    expect(w.light["bf-paper"]).toBe(w.light.surface);
    expect(w.dark["bf-yellow"]).not.toBe(w.light["bf-yellow"]);
    expect(w.light["sh-lift"]).toMatch(/^#32230a/);
  });
  it("other looks override the base and lose Warm Ink's Note code colours", () => {
    expect(t.graphite.light.ink).not.toBe(t["warm-ink"].light.ink);
    expect(t.graphite.light["nc-bg"]).toBeUndefined();
    expect(t["warm-ink"].light["nc-bg"]).toBeDefined();
  });
});
