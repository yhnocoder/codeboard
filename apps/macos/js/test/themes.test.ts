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
    // a shadow list as its shadows (offset, blur, spread, colour); a picked declaration (the selection ring) and a gradient
    expect(w.light["sh-lift"]).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ y: 30, blur: 60, spread: -18, color: expect.stringMatching(/^#32230a/) }),
      ]),
    );
    expect(w.light["card-sel-ring"]).toHaveLength(4);
    expect(t["ink-wash"].light["head-bg"]).toMatchObject({ angle: 90, stops: [{ at: 0 }, { at: 0.45 }, { at: 0.85 }] });
  });
  it("picks the Section's border, ring and wash, and Warm Ink's arrow colour from the links layer", () => {
    const w = t["warm-ink"];
    // --sect-border: 0.5px solid var(--hair); the ring is the non-inset shadow of .sect.sel; the wash .sect::after's background
    expect(w.light["sect-border"]).toEqual({ w: 0.5, style: "solid", color: w.light.hair });
    expect(w.light["sect-sel-ring"]).toEqual([expect.objectContaining({ spread: 3, inset: false })]);
    expect(w.light["sect-wash"]).toMatch(/^#b5552d/);
    expect(w.light["sect-shut-radius"]).toBe(10);
    // :root.look-warm-ink .lyr { --edge: var(--wi-edge) }: the arrows are the warm grey, not the root's --edge
    expect(w.light.edge).toBe(w.light["wi-edge"]);
    expect(w.dark.edge).toBe(w.dark["wi-edge"]);
    const i = t["ink-wash"];
    expect(i.light["secho-offset"]).toEqual({ x: 5, y: 5 });
    expect(i.light["secho-opacity"]).toBe(0.42);
    expect(i.light["sbrush-sel-opacity"]).toBe(0.85);
    expect(i.light["slabel-shut-ml"]).toBe(14);
    expect(i.dark["sect-wash"]).not.toBe(i.light["sect-wash"]);
  });
  it("other looks override the base and lose Warm Ink's Note code colours", () => {
    expect(t.graphite.light.ink).not.toBe(t["warm-ink"].light.ink);
    expect(t.graphite.light["nc-bg"]).toBeUndefined();
    expect(t["warm-ink"].light["nc-bg"]).toBeDefined();
  });
});
