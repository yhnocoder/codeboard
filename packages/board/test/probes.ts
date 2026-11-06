// Budgets that do not depend on the machine: counts of pixels, layers and nodes, not milliseconds. The runners have no GPU, so a
// time says little about raster and image decode, where the cost of #155, #159 and #161 was; what the browser was asked to do (how
// many pixels it decoded, rastered, at what scale) is the same on every machine. Pure functions here: what the page measures
// (pageMeasure, run in the page) and the traces perf.ts records are judged in Node, so the unit tests (test/unit/probes.test.ts)
// run them on made-up inputs.

/** An image the page shows, as pageMeasure saw it: its decoded size and its box on screen (CSS px, at the zoom it is seen at) */
export type ImgSeen = {
  src: string;
  /** naturalWidth × naturalHeight: the pixels decoded */
  nw: number;
  nh: number;
  /** its box on screen in CSS px (getBoundingClientRect: the camera's zoom included) */
  w: number;
  h: number;
  /** zoomMax / zoom of the world it is in (1 outside the world): how much larger it may have been seen earlier */
  grown: number;
};

/**
 * Images whose decoded pixels exceed what they are seen at. The page picks a copy of an image by the size it is seen at
 * (@yhnocoder/markdown picture.ts): the smallest of THUMB_WIDTHS (400, 800, 1600) at least 1.15 times the width shown, else the
 * original. Just past a step (shown at 349 px: 800 = 2.29x the width) that is 5.3x the pixels shown, and it never steps down
 * while the image stays on the page (zoomed in, then out: `grown`), so the budget is 6x the pixels, judged against the largest
 * size the image may have been seen at. The bug it is for (#161: a 2460 × 1796 original shown 400 px wide) is 28x at 100 %.
 * minMP: smaller images (stickers, icons) cost too little to judge.
 */
export const IMAGE_BUDGET = { ratio: 6, minMP: 0.25 };

export type ImageHit = { src: string; decodedMP: number; shownMP: number; ratio: number };

export function imageHits(imgs: readonly ImgSeen[], dpr: number, budget = IMAGE_BUDGET): ImageHit[] {
  const out: ImageHit[] = [];
  for (const i of imgs) {
    const decoded = i.nw * i.nh;
    if (decoded < budget.minMP * 1e6 || i.w <= 0 || i.h <= 0) continue;
    if (/^data:image\/svg|\.svg([?#]|$)/i.test(i.src)) continue; // a vector image is rastered at the size shown
    const g = Math.max(1, i.grown);
    const shown = i.w * i.h * dpr * dpr * g * g;
    const ratio = decoded / shown;
    if (ratio > budget.ratio)
      out.push({
        src: i.src.length > 120 ? `${i.src.slice(0, 117)}…` : i.src,
        decodedMP: +(decoded / 1e6).toFixed(2),
        shownMP: +(shown / 1e6).toFixed(2),
        ratio: +ratio.toFixed(1),
      });
  }
  return out;
}

/** What pageMeasure returns: the images on screen and counts of what the page holds */
export type PageMeasure = {
  dpr: number;
  imgs: ImgSeen[];
  counts: {
    nodes: number;
    cards: number;
    cardsInView: number;
    katex: number;
    imgsInView: number;
    decodedMPInView: number;
  };
};

/**
 * Runs in the board's page (page.evaluate(pageMeasure)): no closures, nothing imported. The world's largest zoom so far is
 * window.__zoomMax, which the harness page keeps (harness.ts); without it an image is judged at the zoom it is seen at now.
 */
export function pageMeasure(): PageMeasure {
  const W = innerWidth,
    H = innerHeight;
  const on = (r: DOMRect) => r.width > 0 && r.height > 0 && r.right > 0 && r.bottom > 0 && r.left < W && r.top < H;
  const world = document.querySelector<HTMLElement>(".world");
  const z = +(/scale\(([\d.e+-]+)\)/.exec(world?.style.transform ?? "")?.[1] ?? 1) || 1;
  const zMax = Math.max(z, +((window as unknown as { __zoomMax?: number }).__zoomMax ?? 0));
  const imgs: ImgSeen[] = [];
  let decoded = 0;
  for (const img of document.images) {
    if (!img.naturalWidth || !img.isConnected) continue;
    const r = img.getBoundingClientRect();
    if (!on(r)) continue;
    imgs.push({
      src: img.currentSrc || img.src,
      nw: img.naturalWidth,
      nh: img.naturalHeight,
      w: r.width,
      h: r.height,
      grown: world?.contains(img) ? zMax / z : 1,
    });
    decoded += img.naturalWidth * img.naturalHeight;
  }
  const cards = document.querySelectorAll(".world .card");
  let inView = 0;
  for (const c of cards) if (on(c.getBoundingClientRect())) inView++;
  return {
    dpr: devicePixelRatio || 1,
    imgs,
    counts: {
      nodes: document.getElementsByTagName("*").length,
      cards: cards.length,
      cardsInView: inView,
      katex: document.getElementsByClassName("katex").length,
      imgsInView: imgs.length,
      decodedMPInView: +(decoded / 1e6).toFixed(2),
    },
  };
}

// ---- raster (perf.ts): from a trace with disabled-by-default-devtools.timeline.layers, which makes the compositor write a
// snapshot of its layer tree at each draw (LayerTreeHostImpl:snapshot: every layer with its ideal and raster scale, every tile
// with its content rect), and the RasterTask of each tile rastered (its tile id and layer id)

/** A tile in a snapshot (the fields read here) */
type SnapTile = { id: string; layer_id: number; content_rect: number[]; contents_scale: number };
/** A layer in a snapshot (the fields read here) */
type SnapLayer = {
  layer_id: number;
  layer_name?: string;
  draws_content?: number | boolean;
  bounds?: { width: number; height: number };
  ideal_contents_scale?: number;
  raster_scales?: { contents_scale: number[] };
  visible_rect?: number[];
};
export type Snapshot = {
  active_tiles?: SnapTile[];
  active_tree?: { layers?: SnapLayer[] };
  device_viewport_size?: { width: number; height: number };
};
/** The trace events read here */
export type TraceEvent = { name: string; ph?: string; ts: number; dur?: number; args?: any };

export const snapshotsOf = (events: readonly TraceEvent[]) =>
  events
    .filter((e) => e.name === "LayerTreeHostImpl:snapshot" && e.args?.snapshot)
    .sort((a, b) => a.ts - b.ts)
    .map((e) => ({ ts: e.ts, s: e.args.snapshot as Snapshot }));

export type RasterStep = {
  /** device pixels rastered (the tiles' content rects) */
  px: number;
  /** of those, the pixels of tiles rastered at more than `wasteOver` times the scale their layer was shown at then */
  wasted: number;
  layers: number;
  tiles: number;
  byLayer: Map<number, number>;
};

/**
 * The pixels rastered in each window [from[i], from[i + 1]) (the last one to `end`): every RasterTask in it, its tile's content
 * rect (device pixels at the tile's scale) taken from the snapshots. A tile rastered and dropped before any snapshot was drawn has
 * no rect: `unknown` counts those (and tasks of a shape not read here), `tasks` all the tasks in the windows. A tile's waste is judged against its layer's ideal scale in the first snapshot drawn after the
 * task (the frame it was rastered for). names: each layer's name in the last snapshot that had it
 */
export function rasterWindows(events: readonly TraceEvent[], from: readonly number[], end: number, wasteOver = 2.05) {
  const tiles = new Map<string, { px: number; scale: number }>();
  const names = new Map<number, string>();
  const snaps = snapshotsOf(events);
  const ideals = snaps.map(({ s }) => {
    const m = new Map<number, number>();
    for (const l of s.active_tree?.layers ?? []) if (l.ideal_contents_scale) m.set(l.layer_id, l.ideal_contents_scale);
    return m;
  });
  for (const { s } of snaps) {
    for (const t of s.active_tiles ?? [])
      tiles.set(t.id.replace(/^cc::Tile\//, ""), {
        px: (t.content_rect[2] ?? 0) * (t.content_rect[3] ?? 0),
        scale: t.contents_scale,
      });
    for (const l of s.active_tree?.layers ?? []) if (l.layer_name) names.set(l.layer_id, l.layer_name);
  }
  const idealAt = (ts: number, layer: number) => {
    let lo = 0,
      hi = snaps.length;
    while (lo < hi) {
      const m = (lo + hi) >> 1;
      if (snaps[m].ts < ts) lo = m + 1;
      else hi = m;
    }
    for (let k = Math.min(lo, snaps.length - 1); k >= 0; k--) {
      const v = ideals[k].get(layer);
      if (v) return v;
    }
    return 0;
  };
  const steps: RasterStep[] = from.map(() => ({ px: 0, wasted: 0, layers: 0, tiles: 0, byLayer: new Map() }));
  let unknown = 0,
    tasks = 0;
  for (const e of events) {
    if (e.name !== "RasterTask") continue;
    let i = -1;
    for (let k = from.length - 1; k >= 0; k--)
      if (e.ts >= from[k]) {
        i = k;
        break;
      }
    if (i < 0 || e.ts >= (from[i + 1] ?? end)) continue;
    tasks++;
    const t = tiles.get(e.args?.tileData?.tileId?.id_ref);
    if (!t) {
      unknown++;
      continue;
    }
    const w = steps[i],
      L = e.args.tileData.layerId,
      ideal = idealAt(e.ts, L);
    w.px += t.px;
    if (ideal && t.scale > wasteOver * ideal) w.wasted += t.px;
    w.tiles++;
    w.byLayer.set(L, (w.byLayer.get(L) ?? 0) + t.px);
    w.layers = w.byLayer.size;
  }
  return { steps, unknown, tasks, names };
}

export type LayerScale = {
  id: number;
  name: string;
  w: number;
  h: number;
  ideal: number;
  raster: number;
  shownPx: number;
};

/** The layers of a snapshot that draw something on screen, with the scale they are shown at (ideal: zoom × device scale) and
 *  the scale they are rastered at */
export function layerScales(s: Snapshot): LayerScale[] {
  const out: LayerScale[] = [];
  for (const l of s.active_tree?.layers ?? []) {
    const v = l.visible_rect ?? [0, 0, 0, 0];
    const raster = l.raster_scales?.contents_scale?.[0];
    if (!l.draws_content || !l.ideal_contents_scale || raster === undefined || !(v[2] > 0 && v[3] > 0)) continue;
    out.push({
      id: l.layer_id,
      name: (l.layer_name ?? "").slice(0, 90),
      w: l.bounds?.width ?? 0,
      h: l.bounds?.height ?? 0,
      ideal: +l.ideal_contents_scale.toFixed(4),
      raster: +raster.toFixed(4),
      // visible_rect is in layer space: times the ideal scale squared, the device pixels it covers on screen
      shownPx: Math.round(v[2] * v[3] * l.ideal_contents_scale * l.ideal_contents_scale),
    });
  }
  return out;
}

/**
 * Sharpness once the camera has stopped: a layer rastered below the scale it is shown at is blurry; one rastered far above it
 * wastes raster and memory (#155: summary columns rastered at device scale while shown at 0.3). The world keeps the scale it was
 * last rastered at until a zoom out passes 2x below it (Canvas.tsx), so up to 2x is by design; past 2.05x (float slack) it is
 * waste. Below 0.97x is blurry (Chromium's raster scales are the ideal ones, snapped by a few per mille). Layers covering less
 * than minShare of the viewport (a caret, a toast's icon) are left out: too small to see or to cost.
 */
export const SCALE_BUDGET = { blurry: 0.97, wasted: 2.05, minShare: 0.01 };

export type ScaleHit = LayerScale & { kind: "blurry" | "wasted"; ratio: number };

export function scaleHits(layers: readonly LayerScale[], viewportPx: number, budget = SCALE_BUDGET): ScaleHit[] {
  const out: ScaleHit[] = [];
  for (const l of layers) {
    if (l.shownPx < budget.minShare * viewportPx) continue;
    const ratio = +(l.raster / l.ideal).toFixed(3);
    if (ratio < budget.blurry) out.push({ ...l, kind: "blurry", ratio });
    else if (ratio > budget.wasted) out.push({ ...l, kind: "wasted", ratio });
  }
  return out;
}

/** One raster pass of perf.ts (its steps, then a rest): what it rastered, counted (VP: viewports of device pixels) */
export type RasterResult = {
  /** median and largest share of the viewport's device pixels rastered by one step */
  stepVP: number;
  stepVPMax: number;
  /** median and most layers rastered by one step */
  stepLayers: number;
  stepLayersMax: number;
  /** viewports of tiles rastered at more than 2x the scale shown, over the whole pass (steps and rest) */
  wastedVP: number;
  /** viewports rastered while coming to rest after the steps */
  restVP: number;
  /** compositor layers drawing something on screen at rest */
  layers: number;
  /** the camera's zoom at rest */
  zoom: number;
  /** at rest: layers rastered below the scale shown, or more than 2x above it (SCALE_BUDGET) */
  blurry: string[];
  wasted: string[];
  /** RasterTasks whose tile no snapshot had (rastered and dropped between two draws): not in the pixels above */
  unknown: number;
  /** RasterTasks in the pass's windows, with or without a known tile, and the layer snapshots drawn: what the counts rest on */
  tasks: number;
  snapshots: number;
};

/**
 * Absolute budgets for the raster passes, per board (perf.ts: the synthetic board of 241 code cards in Sections, and the persona
 * board of Notes with math and big images), from measured runs with headroom (the numbers in the PR that added them). VP is
 * viewports: the pixels rastered over the viewport's device pixels.
 * - drag stepVP: the median pixels one pointer move of a card drag rasters. A lifted card is a layer of its own (#159), so a
 *   move rasters only what follows the card (its arrows): the persona board drags a Note with no arrows, 0 a move, 1.04 when the
 *   card was squashed back into the layer under it. On the synthetic board a move repaints the hub card's 7 long arrows through
 *   its Section's layer (1.7-2.3 on every build measured), so its budget only guards against regressions.
 * - drag restVP (persona): the pixels rastered after the card is put down, until it has settled: 10.4. Most of it is the card
 *   painted again at each frame of its lift shadow's transition back (~0.6 a frame for a tall Note, on its own layer). 14.1-14.8
 *   when .landing ended while the card's scale still eased: Chromium then took the card as overlapping every card painted after
 *   it, gave each its own layer and rastered them all, twice.
 * - dragSection stepVP (persona): the median pixels one pointer move of a Section dragged by its title rasters, with its cards
 *   and the Section inside it. They are carried on layers of their own (.carry), so a move rasters what follows them: the
 *   arrows into, out of and inside the Section (0.73); 1.35-1.46 when the frame and its cards were painted again in the world's
 *   layer at every move (1.46-1.66 on real study boards).
 * - stops stepVP: the pixels one small zoom stop rasters, the move and the rest after it: persona 0.47; 2.2 when the world was
 *   rastered again at every stop (#155). Synthetic: 11-12, about 16 before #155.
 * - fit restVP and wastedVP: Fit to Window from 100 % (the flight is in the rest after the click), all of it and the part at
 *   over 2x the scale shown. While the flight kept the world's hint, every tile coming into view was rastered at 1.0: persona
 *   43-77 (31-73 wasted), synthetic 224 (203 wasted); with the hint off from half the raster scale on, persona 35-40 (3-4),
 *   synthetic 55-84 (2-5). restVP guards the total with headroom (it does not always tell the two apart); wastedVP does.
 * The sharpness at rest (blurry and wasted layers, SCALE_BUDGET) is judged after the passes listed in `sharp`: at 100 %; at the
 * fit (the persona board's summary columns stayed rastered at 1.0 there, 2.4x the scale shown, when the stop past the cut was
 * not rastered again); and at ~150 % after inOutIn (in to 250 %, out below the summary cut, back in: 1 layer blurry at 0.67x
 * when the stop below the cut left the board remembering the 250 % raster while Chromium had rastered at 1.0).
 * After the zoom passes it is reported only: the zoom out stops in the detent's reach of the summary cut, where the world keeps its
 * card-level raster by design (Canvas.tsx: 3.7x at 0.27); and the summary columns, laid out at 1/K of the board, keep the scale
 * they were first rastered at under the world's will-change (1:1 at the cut).
 */
export const RASTER_BUDGET = {
  synthetic: { drag: { stepVP: 2.5 }, stops: { stepVP: 5 }, fit: { restVP: 110, wastedVP: 10 } },
  persona: {
    drag: { stepVP: 0.25, restVP: 12 },
    dragSection: { stepVP: 1 },
    stops: { stepVP: 1.1 },
    fit: { restVP: 48, wastedVP: 10 },
  },
  sharp: ["drag", "pan", "stops", "fit", "inOutIn"],
} as const;

/** A budgeted number: ok when value <= limit, or with atLeast when value >= limit */
export type RasterCheck = { name: string; value: number; limit: number; ok: boolean; atLeast?: boolean };

/**
 * What a pass's counts rest on, so a trace that no longer says what probes.ts reads fails instead of counting nothing: Chromium
 * dropping the layer snapshots, renaming RasterTask or its tile ids (every task unknown), or the layers' raster scales (no layer
 * at rest). Up to 12.5 % of a pass's tasks were unknown in the runs measured (tiles rastered and dropped between two draws while
 * panning), so past a quarter the pixels counted are not the pixels rastered
 */
export const TRACE_BUDGET = { unknownShare: 0.25 };

/** The budgeted numbers of a run's raster passes (missing passes are not judged) */
export function rasterChecks(
  passes: Readonly<Record<string, RasterResult>>,
  board: "synthetic" | "persona",
  /** the passes that ran: a budgeted one missing from them is not judged, one that ran and has no result fails */
  ran: readonly string[] = Object.keys(passes),
  budget = RASTER_BUDGET,
): RasterCheck[] {
  const out: RasterCheck[] = [];
  const asked = new Set([...Object.keys(budget[board]), ...budget.sharp].filter((p) => ran.includes(p)));
  for (const pass of ran) {
    const r = passes[pass];
    if (!r) {
      out.push({ name: `${pass} results`, value: 0, limit: 1, ok: false, atLeast: true });
      continue;
    }
    out.push({ name: `${pass} layer snapshots`, value: r.snapshots, limit: 1, ok: r.snapshots >= 1, atLeast: true });
    out.push({ name: `${pass} raster tasks`, value: r.tasks, limit: 1, ok: r.tasks >= 1, atLeast: true });
    const share = r.tasks ? +(r.unknown / r.tasks).toFixed(3) : 0;
    out.push({
      name: `${pass} share of raster tasks with no tile`,
      value: share,
      limit: TRACE_BUDGET.unknownShare,
      ok: share <= TRACE_BUDGET.unknownShare,
    });
  }
  for (const [pass, limits] of Object.entries(budget[board]))
    for (const [k, limit] of Object.entries(limits as Record<string, number>)) {
      const v = (passes[pass] as Record<string, unknown> | undefined)?.[k];
      if (typeof v === "number") out.push({ name: `${pass} ${k}`, value: v, limit, ok: v <= limit });
    }
  for (const pass of budget.sharp) {
    const r = passes[pass];
    if (!r || !asked.has(pass)) continue;
    out.push({ name: `${pass} layers at rest`, value: r.layers, limit: 1, ok: r.layers >= 1, atLeast: true });
    out.push({ name: `${pass} blurry layers at rest`, value: r.blurry.length, limit: 0, ok: !r.blurry.length });
    out.push({ name: `${pass} wasted layers at rest`, value: r.wasted.length, limit: 0, ok: !r.wasted.length });
  }
  return out;
}

/** The median of xs (0 when empty) */
export const median = (xs: readonly number[]) => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b),
    m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
