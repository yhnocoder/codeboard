// The machine-independent budgets (test/probes.ts): the image budget the harness checks at the end of every scenario, and the
// raster counts perf.ts reads from a trace with the compositor's layer snapshots
import { describe, expect, it } from "vitest";
import {
  IMAGE_BUDGET,
  imageHits,
  layerScales,
  rasterChecks,
  rasterWindows,
  scaleHits,
  type ImgSeen,
  type RasterResult,
  type Snapshot,
  type TraceEvent,
} from "../probes";

const img = (o: Partial<ImgSeen>): ImgSeen => ({
  src: "assets/a.png",
  nw: 800,
  nh: 600,
  w: 400,
  h: 300,
  grown: 1,
  ...o,
});

describe("imageHits", () => {
  it("flags a big original shown small (#161: 2460 × 1796 shown 400 px wide)", () => {
    const hits = imageHits([img({ nw: 2460, nh: 1796, w: 400, h: 292 })], 1);
    expect(hits).toHaveLength(1);
    expect(hits[0].ratio).toBeGreaterThan(25);
    expect(hits[0].decodedMP).toBeCloseTo(4.42, 2);
  });
  it("passes every copy the picker can choose: just past a step, the next copy is 2.29x the width shown", () => {
    // shown 349 px: 400 is under 349 × 1.15, so the 800 px copy: 5.25x the pixels
    expect(imageHits([img({ nw: 800, nh: 600, w: 349, h: 261.75 })], 1)).toEqual([]);
    expect(imageHits([img({ nw: 1600, nh: 1200, w: 698, h: 523.5 })], 1)).toEqual([]);
  });
  it("counts device pixels: the same image is fine on a 2x screen", () => {
    const i = img({ nw: 1600, nh: 1200, w: 400, h: 300 });
    expect(imageHits([i], 1)).toHaveLength(1);
    expect(imageHits([i], 2)).toEqual([]);
  });
  it("judges an image against the largest zoom it may have been seen at (copies step up, never down)", () => {
    const i = img({ nw: 3000, nh: 2000, w: 650, h: 433 });
    expect(imageHits([i], 1)).toHaveLength(1);
    expect(imageHits([{ ...i, grown: 2.5 }], 1)).toEqual([]);
  });
  it("leaves out small images and vector images", () => {
    expect(imageHits([img({ nw: 500, nh: 400, w: 20, h: 16 })], 1)).toEqual([]);
    expect(imageHits([img({ src: "data:image/svg+xml;base64,AAAA", nw: 4000, nh: 4000, w: 40, h: 40 })], 1)).toEqual(
      [],
    );
    expect(imageHits([img({ src: "x/icon.svg?v=2", nw: 4000, nh: 4000, w: 40, h: 40 })], 1)).toEqual([]);
    expect(IMAGE_BUDGET.minMP).toBeGreaterThan(0);
  });
});

const tile = (id: string, layer: number, w: number, h: number, scale = 1) => ({
  id: `cc::Tile/${id}`,
  layer_id: layer,
  content_rect: [0, 0, w, h],
  contents_scale: scale,
});
const layer = (id: number, ideal: number, raster: number, vis = [0, 0, 1000, 1000], name = `L${id}`) => ({
  layer_id: id,
  layer_name: name,
  draws_content: 1,
  bounds: { width: 1000, height: 1000 },
  ideal_contents_scale: ideal,
  raster_scales: { contents_scale: [raster, raster] },
  visible_rect: vis,
});
const snap = (ts: number, s: Snapshot): TraceEvent => ({
  name: "LayerTreeHostImpl:snapshot",
  ph: "O",
  ts,
  args: { snapshot: s },
});
const task = (ts: number, tileId: string, layerId: number): TraceEvent => ({
  name: "RasterTask",
  ph: "X",
  ts,
  dur: 100,
  args: { tileData: { layerId, tileId: { id_ref: tileId } } },
});

describe("rasterWindows", () => {
  const events: TraceEvent[] = [
    task(10, "a", 1),
    task(12, "b", 2),
    snap(15, {
      active_tiles: [tile("a", 1, 256, 256), tile("b", 2, 100, 50, 3)],
      active_tree: { layers: [layer(1, 1, 1), layer(2, 1, 3)] },
    }),
    task(25, "a", 1),
    task(26, "gone", 1),
    snap(30, { active_tiles: [tile("a", 1, 256, 256)], active_tree: { layers: [layer(1, 1, 1)] } }),
    task(45, "a", 1),
  ];
  it("sums each window's tiles by their content rects, with the layers they belong to", () => {
    const { steps, unknown, names } = rasterWindows(events, [0, 20, 40], 50);
    expect(steps.map((s) => s.px)).toEqual([256 * 256 + 5000, 256 * 256, 256 * 256]);
    expect(steps.map((s) => s.layers)).toEqual([2, 1, 1]);
    expect(unknown).toBe(1);
    expect(names.get(2)).toBe("L2");
  });
  it("counts as wasted the tiles rastered at more than 2x their layer's scale shown in the next frame", () => {
    const { steps } = rasterWindows(events, [0, 20, 40], 50);
    expect(steps.map((s) => s.wasted)).toEqual([5000, 0, 0]);
  });
  it("leaves out tasks before the first window and after the end", () => {
    const { steps } = rasterWindows(events, [11, 20], 40);
    expect(steps.map((s) => s.tiles)).toEqual([1, 1]);
  });
});

describe("layerScales and scaleHits", () => {
  const s: Snapshot = {
    active_tree: {
      layers: [
        layer(1, 0.3, 1, [0, 0, 1000, 1000], "LayoutBlockFlow DIV class='sumcol'"), // #155: device scale, shown at 0.3
        layer(2, 1.8, 1, [0, 0, 500, 500]), // zoomed in past the raster scale: blurry
        layer(3, 1, 1.9), // the world, rastered where it last stopped: under 2x, by design
        layer(4, 0.3, 1, [0, 0, 10, 10]), // too small to matter
        layer(5, 1, 1, [0, 0, 0, 0]), // off screen
        { ...layer(6, 1, 1), draws_content: 0 },
      ],
    },
  };
  const vp = 1400 * 900;
  it("keeps the layers drawing on screen, with the device pixels they cover", () => {
    const ls = layerScales(s);
    expect(ls.map((l) => l.id)).toEqual([1, 2, 3, 4]);
    expect(ls[0].shownPx).toBe(90000);
  });
  it("flags raster below the scale shown and more than 2x above it", () => {
    const hits = scaleHits(layerScales(s), vp);
    expect(hits.map((h) => [h.id, h.kind])).toEqual([
      [1, "wasted"],
      [2, "blurry"],
    ]);
    expect(hits[0].ratio).toBeCloseTo(3.333, 3);
  });
});

const pass = (o: Partial<RasterResult> = {}): RasterResult => ({
  stepVP: 0.1,
  stepVPMax: 1,
  stepLayers: 1,
  stepLayersMax: 2,
  wastedVP: 0,
  restVP: 0,
  layers: 3,
  zoom: 1,
  blurry: [],
  wasted: [],
  unknown: 0,
  tasks: 40,
  snapshots: 12,
  ...o,
});

describe("rasterChecks", () => {
  it("judges each budgeted number of the passes a board has", () => {
    const checks = rasterChecks({ drag: pass({ stepVP: 0.62 }), stops: pass({ stepVP: 0.47 }) }, "persona");
    expect(checks.find((c) => c.name === "drag stepVP")).toMatchObject({ value: 0.62, limit: 0.25, ok: false });
    expect(checks.find((c) => c.name === "stops stepVP")?.ok).toBe(true);
    expect(checks.some((c) => c.name.startsWith("cut"))).toBe(false);
  });
  it("counts the blurry and wasted layers at rest of the passes judged for sharpness, not of the others", () => {
    const checks = rasterChecks({ stops: pass({ blurry: ["x"] }), cut: pass({ wasted: ["y"] }) }, "synthetic");
    expect(checks.find((c) => c.name === "stops blurry layers at rest")).toMatchObject({ value: 1, ok: false });
    expect(checks.some((c) => c.name.startsWith("cut") && c.name.endsWith("at rest"))).toBe(false);
  });
  it("judges Fit to Window by what its flight rasters and by its sharpness at rest", () => {
    const checks = rasterChecks({ fit: pass({ restVP: 77, wastedVP: 73, wasted: ["sumcol"] }) }, "persona");
    expect(checks.find((c) => c.name === "fit restVP")).toMatchObject({ value: 77, ok: false });
    expect(checks.find((c) => c.name === "fit wastedVP")).toMatchObject({ value: 73, ok: false });
    expect(checks.find((c) => c.name === "fit wasted layers at rest")).toMatchObject({ value: 1, ok: false });
    const fixed = rasterChecks({ fit: pass({ restVP: 36, wastedVP: 4 }) }, "persona");
    expect(fixed.filter((c) => !c.ok)).toEqual([]);
  });
  it("passes a board whose passes all have their counts", () => {
    const checks = rasterChecks({ drag: pass(), pan: pass(), stops: pass() }, "persona");
    expect(checks.filter((c) => !c.ok)).toEqual([]);
  });
  it("fails a pass that ran but brought back no results", () => {
    const checks = rasterChecks({ drag: pass() }, "persona", ["drag", "stops"]);
    expect(checks.find((c) => c.name === "stops results")).toMatchObject({ value: 0, ok: false, atLeast: true });
  });
  it("fails a pass with no layer snapshots or no raster tasks in the trace, instead of counting 0 px", () => {
    const checks = rasterChecks({ drag: pass({ snapshots: 0, tasks: 0, stepVP: 0 }) }, "persona");
    expect(checks.find((c) => c.name === "drag layer snapshots")?.ok).toBe(false);
    expect(checks.find((c) => c.name === "drag raster tasks")?.ok).toBe(false);
    expect(checks.find((c) => c.name === "drag stepVP")?.ok).toBe(true);
  });
  it("fails a pass where most raster tasks could not be matched to a tile", () => {
    const checks = rasterChecks({ drag: pass({ tasks: 40, unknown: 30 }) }, "persona");
    expect(checks.find((c) => c.name === "drag share of raster tasks with no tile")).toMatchObject({
      value: 0.75,
      ok: false,
    });
    const fine = rasterChecks({ drag: pass({ tasks: 223, unknown: 32 }) }, "persona"); // the most seen on a real run
    expect(fine.find((c) => c.name === "drag share of raster tasks with no tile")?.ok).toBe(true);
  });
  it("fails a sharpness check that found no layers at rest", () => {
    const checks = rasterChecks({ stops: pass({ layers: 0 }) }, "synthetic");
    expect(checks.find((c) => c.name === "stops layers at rest")).toMatchObject({ value: 0, ok: false, atLeast: true });
  });
  it("counts every raster task in the windows, matched to a tile or not", () => {
    const { tasks, unknown } = rasterWindows(
      [
        task(5, "a", 1),
        { name: "RasterTask", ph: "X", ts: 6, dur: 1, args: {} },
        snap(8, { active_tiles: [tile("a", 1, 10, 10)] }),
        task(25, "a", 1),
      ],
      [0],
      20,
    );
    expect([tasks, unknown]).toEqual([2, 1]);
  });
});
