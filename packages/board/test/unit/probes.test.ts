// The machine-independent budgets (test/probes.ts): the image budget the harness checks at the end of every scenario, and the
// raster counts perf.ts reads from a trace with the compositor's layer snapshots
import { describe, expect, it } from "vitest";
import {
  IMAGE_BUDGET,
  flashHits,
  gridOf,
  handoffHits,
  imageHits,
  jumpHits,
  styleHits,
  twiceHits,
  unusedAllows,
  vanishHits,
  layerScales,
  rasterChecks,
  rasterWindows,
  scaleHits,
  type AllowEntry,
  type Grid,
  type ImgSeen,
  type KindLook,
  type RasterResult,
  type Sample,
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
  it("judges what a card drag rasters after the drop on the persona board", () => {
    const checks = rasterChecks({ drag: pass({ restVP: 14.1 }) }, "persona");
    expect(checks.find((c) => c.name === "drag restVP")).toMatchObject({ value: 14.1, limit: 12, ok: false });
    const synthetic = rasterChecks({ drag: pass({ restVP: 14.1 }) }, "synthetic");
    expect(synthetic.some((c) => c.name === "drag restVP")).toBe(false);
  });
  it("judges a Section drag on the persona board by the pixels a move rasters", () => {
    const checks = rasterChecks({ dragSection: pass({ stepVP: 1.46 }) }, "persona");
    expect(checks.find((c) => c.name === "dragSection stepVP")).toMatchObject({ value: 1.46, limit: 1, ok: false });
    expect(rasterChecks({ dragSection: pass({ stepVP: 0.73 }) }, "persona").filter((c) => !c.ok)).toEqual([]);
  });
  it("judges a card drag that snaps to its row on the persona board by the pixels a move rasters", () => {
    const checks = rasterChecks({ dragSnap: pass({ stepVP: 0.47 }) }, "persona");
    expect(checks.find((c) => c.name === "dragSnap stepVP")).toMatchObject({ value: 0.47, limit: 0.25, ok: false });
    expect(rasterChecks({ dragSnap: pass({ stepVP: 0 }) }, "persona").filter((c) => !c.ok)).toEqual([]);
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

// ---- the motion probes (watch.ts) and the consistency matrix (card-kinds.spec.ts)

/** A grid of 8 px cells, every quarter of every cell one grey; `paint` sets some cells to another grey */
const grid = (cols: number, rows: number, grey: number, paint: Record<number, number> = {}): Grid => {
  const q = new Uint8Array(cols * rows * 12).fill(grey);
  for (const [i, v] of Object.entries(paint)) q.fill(v, +i * 12, +i * 12 + 12);
  return { cols, rows, cell: 8, q };
};

describe("gridOf", () => {
  it("averages each quarter of each cell", () => {
    const w = 16,
      h = 8,
      rgba = new Uint8Array(w * h * 4);
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4;
        rgba[i] = x < 4 && y < 4 ? 200 : 0; // the first cell's top-left quarter red
        rgba[i + 3] = 255;
      }
    const g = gridOf(rgba, w, h);
    expect([g.cols, g.rows]).toEqual([2, 1]);
    expect([...g.q.slice(0, 12)]).toEqual([200, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
    expect(g.q.slice(12).every((v) => v === 0)).toBe(true);
  });
});

describe("flashHits", () => {
  const still = (n: number) => Array.from({ length: n }, () => grid(4, 4, 240));
  it("flags cells that go away for a frame and come back (#151: the paper missing for a frame)", () => {
    const gs = still(6);
    gs[3] = grid(4, 4, 240, { 5: 60, 6: 60 });
    const hits = flashHits(
      gs,
      gs.map(() => []),
    );
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ from: 2, to: 4, cells: 2, box: { x: 8, y: 8, w: 16, h: 8 } });
  });
  it("passes a change that stays, and one that takes longer than a few frames to come back", () => {
    const stays = still(6).map((g, i) => (i >= 3 ? grid(4, 4, 240, { 5: 60, 6: 60 }) : g));
    expect(
      flashHits(
        stays,
        stays.map(() => []),
      ),
    ).toEqual([]);
    const slow = still(8).map((g, i) => (i >= 2 && i <= 5 ? grid(4, 4, 240, { 5: 60, 6: 60 }) : g));
    expect(
      flashHits(
        slow,
        slow.map(() => []),
      ),
    ).toEqual([]);
  });
  it("leaves out masked cells (what moved) and single cells", () => {
    const gs = still(6);
    gs[3] = grid(4, 4, 240, { 5: 60, 6: 60, 15: 60 });
    expect(
      flashHits(
        gs,
        gs.map((_, f) => (f === 3 ? [{ x: 8, y: 8, w: 16, h: 8 }] : [])),
      ),
    ).toEqual([]);
  });
  it("needs the cell at rest before: a cell that was changing anyway is not a flash", () => {
    const p = (v: number) => grid(4, 4, 240, { 5: v, 6: v });
    const gs = [p(120), p(240), p(60), p(240), p(240)];
    expect(
      flashHits(
        gs,
        gs.map(() => []),
      ),
    ).toEqual([]);
  });
});

const sample = (rects: Sample["rects"], z = 1, o: [number, number] = [0, 0]) => ({ rects, z, o });

describe("jumpHits", () => {
  it("flags a card that should stay and moved or changed size, at the first frame it did", () => {
    const s = [
      sample({ "card:a": [0, 0, 100, 50] }),
      sample({ "card:a": [0, 0, 100, 50] }),
      sample({ "card:a": [0, 0, 100, 54] }),
    ];
    expect(jumpHits(s, () => "still")).toMatchObject([{ key: "card:a", kind: "moved", frame: 2, by: 4 }]);
  });
  it("judges the world at the camera's zoom: a quarter of a world unit at 4x is a pixel", () => {
    const s = [sample({ "card:a": [0, 0, 100, 50] }, 4), sample({ "card:a": [0.25, 0, 100, 50] }, 4)];
    expect(jumpHits(s, () => "still")).toHaveLength(1);
    expect(
      jumpHits(
        s.map((x) => ({ ...x, z: 1 })),
        () => "still",
      ),
    ).toEqual([]);
  });
  it("flags a step far longer than the ones around it, not a smooth move or a pointer's steps", () => {
    const at = (ys: number[]) => ys.map((y) => sample({ "card:a": [0, y, 100, 50] }));
    expect(jumpHits(at([0, 2, 4, 30, 31, 32]), () => "moves")).toMatchObject([{ kind: "jumped", frame: 3, by: 26 }]);
    expect(jumpHits(at([0, 4, 12, 20, 26, 29, 30]), () => "moves")).toEqual([]);
    expect(jumpHits(at([0, 2, 4, 30, 31, 32]), () => "free")).toEqual([]);
  });
  it("lets a moving card grow at once (a line added) and skips frames it is not seen in", () => {
    const s = [
      sample({ "card:a": [0, 0, 100, 50] }),
      sample({ "card:a": [0, 0, 100, 80] }),
      sample({}),
      sample({ "card:a": [0, 0, 100, 80] }),
    ];
    expect(jumpHits(s, () => "moves")).toEqual([]);
  });
});

describe("vanishHits", () => {
  it("flags a kept element gone in some frames", () => {
    const s = [{ shown: { ".crumbs": 1 } }, { shown: { ".crumbs": 0 } }, { shown: { ".crumbs": 1 } }];
    expect(vanishHits(s)).toEqual([{ sel: ".crumbs", frames: [1] }]);
    expect(vanishHits([{ shown: { ".crumbs": 0 } }, { shown: { ".crumbs": 0 } }])).toEqual([]);
  });
});

const word = (t: string, x: number, y: number, w: number, h: number, el: number) => ({ t, b: { x, y, w, h }, el });

describe("twiceHits", () => {
  it("flags the same words shown twice over each other for a moment (#169: the crumb and its copy)", () => {
    const crumb = word("Deep", 226.5, 17.75, 31.6, 15, 1),
      copy = word("Deep", 226.5, 17.9, 30.8, 15, 2);
    const s = [{ texts: [crumb] }, { texts: [crumb, copy] }, { texts: [copy] }, { texts: [] }];
    expect(twiceHits(s)).toMatchObject([{ frame: 1, t: "Deep" }]);
  });
  it("passes words over each other before and after too (cards that overlap), and a morph to another size", () => {
    const a = word("self", 36, 263, 59, 6, 1),
      b = word("self", 36, 263, 47, 6, 2);
    expect(twiceHits([{ texts: [a, b] }, { texts: [a, b] }, { texts: [a, b] }])).toEqual([]);
    const title = word("KV cache budget", 87, 68, 97, 15, 1),
      h1 = word("KV cache budget", 74, 67, 177, 33, 2);
    expect(twiceHits([{ texts: [title] }, { texts: [title, h1] }, { texts: [h1] }])).toEqual([]);
  });
});

describe("handoffHits", () => {
  const f = (texts: ReturnType<typeof word>[], z = 1) => ({ texts, z, o: [0, 0] as [number, number] });
  it("flags a copy that takes over at another size (#169: 12.20 px against the crumb's 12.5)", () => {
    const s = [f([word("Deep", 226.5, 17.75, 31.625, 15, 1)]), f([word("Deep", 233.2, 19.7, 30.8, 15, 2)])];
    expect(handoffHits(s)).toMatchObject([{ frame: 1, t: "Deep", by: 0.82 }]);
  });
  it("passes a copy at the original's size, already on its way, and frames where the camera moved", () => {
    const s = [f([word("Deep", 226.5, 17.75, 31.625, 15, 1)]), f([word("Deep", 233.2, 19.5, 31.6, 15, 2)])];
    expect(handoffHits(s)).toEqual([]);
    const moved = [f([word("seq", 480, 795, 77.8, 8.7, 1)]), f([word("seq", 466, 798, 75.9, 8.5, 2)], 1.1)];
    expect(handoffHits(moved)).toEqual([]);
    // a copy landing later, frames after the action: when it lands depends on the host's timing
    const late = [...Array(5)].map(() => f([word("Deep", 920, 203, 28.46, 13.5, 1)]));
    late.push(f([word("Deep", 920, 204, 27.95, 13.5, 2)]));
    expect(handoffHits(late)).toEqual([]);
  });
});

describe("styleHits", () => {
  const looks = (note: string): KindLook[] => [
    { kind: "code", parts: { headLine: "none", corners: "12px" } },
    { kind: "free", parts: { headLine: "none", corners: "12px" } },
    { kind: "note", parts: { headLine: note, corners: "12px" } },
    { kind: "image", parts: { headLine: null, corners: "12px" } },
  ];
  it("flags a kind whose shared part looks unlike most kinds' (#158: Warm Ink's header line)", () => {
    expect(styleHits("warm-ink light", looks("1px solid"), [])).toMatchObject([
      { part: "headLine", kind: "note", value: "1px solid", most: "none", others: ["code", "free"] },
    ]);
    expect(styleHits("warm-ink light", looks("none"), [])).toEqual([]);
  });
  it("lets through what ALLOW names, in the themes it names", () => {
    const allow: AllowEntry[] = [{ part: "headLine", kind: "note", in: "warm-ink", why: "Notes keep their line" }];
    expect(styleHits("warm-ink dark", looks("1px solid"), allow)).toEqual([]);
    expect(styleHits("ink-wash dark", looks("1px solid"), allow)).toHaveLength(1);
  });
  it("names the entries that let nothing through", () => {
    const allow: AllowEntry[] = [
      { part: "headLine", kind: "note", why: "used" },
      { part: "corners", kind: "image", why: "stale" },
    ];
    expect(unusedAllows([{ theme: "warm-ink light", looks: looks("1px solid") }], allow)).toEqual([allow[1]]);
  });
});
