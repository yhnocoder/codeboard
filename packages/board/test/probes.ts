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

/** A tile in a snapshot (the fields read here): gpu_memory_usage is the bytes of its resource (0 for a solid colour) */
type SnapTile = {
  id: string;
  layer_id: number;
  content_rect: number[];
  contents_scale: number;
  gpu_memory_usage?: number;
};
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
  /** the tile manager: whether its last pass over the tiles ran out of memory for some it wanted, and its memory limits */
  tile_manager_basic_state?: {
    did_oom_on_last_assign?: boolean;
    global_state?: { hard_memory_limit_in_bytes?: number; soft_memory_limit_in_bytes?: number };
  };
};

/** The tile memory of a snapshot: the active tiles' resources (MB, and viewports of 4-byte device pixels), the tile manager's
 *  hard limit (MB) and whether it ran out of memory for tiles it wanted (it then draws those as nothing: on a GPU, the blank
 *  frames and holes R2 is about) */
export function tileMemory(s: Snapshot) {
  let bytes = 0;
  for (const t of s.active_tiles ?? []) bytes += t.gpu_memory_usage ?? 0;
  const vs = s.device_viewport_size;
  const tm = s.tile_manager_basic_state;
  return {
    mb: +(bytes / 1048576).toFixed(1),
    vp: vs ? +(bytes / 4 / (vs.width * vs.height)).toFixed(2) : 0,
    limitMB: +((tm?.global_state?.hard_memory_limit_in_bytes ?? 0) / 1048576).toFixed(0),
    oom: !!tm?.did_oom_on_last_assign,
  };
}
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
  /** the active tiles' memory (tileMemory): the most any snapshot of the pass held, in MB and viewports, and at rest; the tile
   *  manager's hard limit; the snapshots in which it had run out of memory for tiles it wanted */
  tileMBMax: number;
  tileVPMax: number;
  tileMBRest: number;
  tileLimitMB: number;
  oomSnapshots: number;
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
 * - dragSnap stepVP (persona): the same Note dragged sideways along its row, its top snapped to the row's with the guide along
 *   it showing at every move: 0 a move, since the guides are a layer of their own while dragging (styles.css .guides.live) and
 *   the guide that stays is not painted again; 0.47 when the guides were painted in the card level's layer and made anew at
 *   every move (0.3-0.6 on real study boards).
 * - dragSection stepVP (persona): the median pixels one pointer move of a Section dragged by its title rasters, with its cards
 *   and the Section inside it. They are carried on layers of their own (.carry), so a move rasters what follows them: the
 *   arrows into, out of and inside the Section (0.73); 1.35-1.46 when the frame and its cards were painted again in the world's
 *   layer at every move (1.46-1.66 on real study boards).
 * - stops stepVP: the pixels one small zoom stop rasters, the move and the rest after it: persona 0.47; 2.2 when the world was
 *   rastered again at every stop (#155). Synthetic: 11-12, about 16 before #155.
 * - nearCut wastedVP (persona): at rest at 0.34 (just above the summary cut, the card level shown), 20 steps of pans and the
 *   pointer moved over the cards, the pixels rastered at over 2x the scale shown: 0.1-0.2 (CI's 1x screen; 1.25 at 2x). 12 when the hint came back on at each
 *   pan and Chromium rastered the world at 1.0 there (2.9x; 5.9x on a 2x screen), and every card a hover painted again with it:
 *   more tiles than the GPU kept, drawn as holes in the cards and images while the pointer moved.
 * - fit restVP and wastedVP: Fit to Window from 100 % (the flight is in the rest after the click), all of it and the part at
 *   over 2x the scale shown. While the flight kept the world's hint, every tile coming into view was rastered at 1.0: persona
 *   43-77 (31-73 wasted), synthetic 224 (203 wasted); with the hint off from half the raster scale to the end, every layer in
 *   view was rastered at every frame: persona 35-37 (3-4), synthetic 55-84 (2-5); with the hint put back below a quarter of
 *   the device scale and the world rastered again only as the scale halves there (Canvas.tsx HINT_KEEPS), persona 21-26 (4-6).
 *   Rastered at the scale shown on every frame (#203): persona 42-47 (0.6-1.4 wasted) in 5 local runs, and 44.8 and 54.2 on CI
 *   for the same commit (Regular 2026-11-11). The total grows with the frames the flight gets, and the flight is a wall-clock
 *   spring whose step is capped at 32 ms (state/camera.ts), so a slower runner draws it in more frames. A fixed frame count would
 *   need the page clock faked from the click on, which would also stop the timers and frame waits of the passes after it; so the
 *   budget leaves 1.2x over the most seen: 65. restVP guards the total (it does not always tell keeping the hint from dropping
 *   it); wastedVP does, and stays at 10.
 * The sharpness at rest (blurry and wasted layers, SCALE_BUDGET) is judged after the passes listed in `sharp`: at 100 %; at 0.34
 * after nearCut (the world at 1.0 there before, 2.9x); at the
 * fit (the persona board's summary columns stayed rastered at 1.0 there, 2.4x the scale shown, when the stop past the cut was
 * not rastered again); and at ~150 % after inOutIn (in to 250 %, out below the summary cut, back in: 1 layer blurry at 0.67x
 * when the stop below the cut left the board remembering the 250 % raster while Chromium had rastered at 1.0).
 * After the zoom passes it is reported only: the summary columns, laid out at 1/K of the board, keep the scale
 * they were first rastered at under the world's will-change (1:1 at the cut).
 * Since the world lost its will-change hint (it is rastered at the scale shown on every frame, never stretched as a bitmap:
 * Canvas.tsx), every zoom step rasters what is in and around the view at its own scale, a small one too: stops stepVP is
 * 9.8 synthetic and 2.7 persona (2.5-2.9 and 0.47 while a stop zoomed a little was left as it was), and the Fit's flight rasters
 * each of its frames to the end, persona restVP 37-45 (27-28 before). The budgets hold those numbers; the times did not grow
 * (zoom work per step 0.91x on the synthetic board).
 */
export const RASTER_BUDGET = {
  synthetic: { drag: { stepVP: 2.5 }, stops: { stepVP: 11 }, fit: { restVP: 110, wastedVP: 10 } },
  persona: {
    drag: { stepVP: 0.25, restVP: 12 },
    dragSnap: { stepVP: 0.25 },
    dragSection: { stepVP: 1 },
    nearCut: { wastedVP: 1 },
    stops: { stepVP: 3 },
    fit: { restVP: 65, wastedVP: 10 },
  },
  sharp: ["drag", "pan", "nearCut", "stops", "fit", "inOutIn"],
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
    // out of tile memory, the compositor draws the tiles it could not keep as nothing: on a GPU, a blank frame or a hole
    out.push({ name: `${pass} snapshots out of tile memory`, value: r.oomSnapshots, limit: 0, ok: !r.oomSnapshots });
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

// ---- motion probes (watch.ts): a watched action's frames, stepped on the page's clock with the document timeline frozen, so
// each frame is the same on every machine. Judged here, on what watch.ts sampled: the frames' pixels (cell grids), the rects of
// cards, arrows and chrome, the text the page shows and the elements that must stay shown

/** A screenshot reduced to cells: each CELL × CELL block of CSS px split in 2 × 2 quarters, the mean RGB of each (12 bytes a cell) */
export type Grid = { cols: number; rows: number; cell: number; q: Uint8Array };
/** A box in CSS px on screen */
export type Box = { x: number; y: number; w: number; h: number };

/** rgba: a screenshot w × h at 1 px per CSS px */
export function gridOf(rgba: Uint8Array, w: number, h: number, cell = 8): Grid {
  const cols = Math.floor(w / cell),
    rows = Math.floor(h / cell),
    half = cell >> 1;
  const q = new Uint8Array(cols * rows * 12);
  for (let r = 0; r < rows; r++)
    for (let c = 0; c < cols; c++)
      for (let k = 0; k < 4; k++) {
        const x0 = c * cell + (k & 1) * half,
          y0 = r * cell + (k >> 1) * half;
        let R = 0,
          G = 0,
          B = 0;
        for (let y = y0; y < y0 + half; y++)
          for (let x = x0; x < x0 + half; x++) {
            const i = (y * w + x) * 4;
            R += rgba[i];
            G += rgba[i + 1];
            B += rgba[i + 2];
          }
        const n = half * half,
          o = (r * cols + c) * 12 + k * 3;
        q[o] = Math.round(R / n);
        q[o + 1] = Math.round(G / n);
        q[o + 2] = Math.round(B / n);
      }
  return { cols, rows, cell, q };
}

/** The largest difference of one quarter's channel between two frames' cell i */
const cellDiff = (a: Grid, b: Grid, i: number) => {
  let d = 0;
  for (let k = i * 12; k < i * 12 + 12; k++) d = Math.max(d, Math.abs(a.q[k] - b.q[k]));
  return d;
};

const meets = (a: Box, b: Box) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

/**
 * A flash: a cell that was at rest (the same in the frame before) changes for 1 to maxFrames frames, every one of them unlike the
 * rest (more than twice `same`, at least one by `big`), and then shows what it showed before (within `same`) and stays (or the
 * recording ends). Something blinked off and on, or on and off: #151's Ink Wash paper missing for a frame while its new image
 * decoded. A cell where something moved in those frames (a box watch.ts masks: a card or arrow that moved, a region the scenario
 * leaves out) is not judged, since a thin line passing over a cell looks the same. Quarters of 4 px compared one by one keep
 * text that slides by from looking like the text it replaced. Hit cells of the same frames joined by an edge are one hit, kept
 * when they are at least minCells
 */
export const FLASH_BUDGET = { same: 6, big: 48, maxFrames: 3, minCells: 2 };

export type FlashHit = { from: number; to: number; box: Box; cells: number; diff: number };

export function flashHits(
  grids: readonly Grid[],
  masks: readonly (readonly Box[])[],
  budget = FLASH_BUDGET,
): FlashHit[] {
  if (grids.length < 3) return [];
  const g0 = grids[0],
    n = g0.cols * g0.rows,
    last = grids.length - 1;
  const masked = (i: number, from: number, to: number) => {
    const c = i % g0.cols,
      r = (i / g0.cols) | 0;
    const b = { x: c * g0.cell, y: r * g0.cell, w: g0.cell, h: g0.cell };
    for (let f = from; f <= to; f++) for (const m of masks[f] ?? []) if (meets(b, m)) return true;
    return false;
  };
  // (from, to) → hit cells with their largest difference
  const found = new Map<string, Map<number, number>>();
  for (let i = 0; i < n; i++)
    for (let a = 0; a < last - 1; a++) {
      if (a > 0 && cellDiff(grids[a - 1], grids[a], i) > budget.same) continue;
      let peak = 0;
      for (let k = a + 1; k <= Math.min(last, a + 1 + budget.maxFrames); k++) {
        const d = cellDiff(grids[a], grids[k], i);
        if (k > a + 1 && d <= budget.same) {
          const rests = k === last || cellDiff(grids[k], grids[k + 1], i) <= budget.same;
          if (peak >= budget.big && rests && !masked(i, a, k)) {
            const key = `${a}-${k}`;
            if (!found.has(key)) found.set(key, new Map());
            found.get(key)!.set(i, peak);
          }
          break;
        }
        if (d <= 2 * budget.same) break;
        peak = Math.max(peak, d);
      }
    }
  const out: FlashHit[] = [];
  for (const [key, cells] of found) {
    const [from, to] = key.split("-").map(Number);
    const seen = new Set<number>();
    for (const start of cells.keys()) {
      if (seen.has(start)) continue;
      const comp: number[] = [];
      const stack = [start];
      seen.add(start);
      while (stack.length) {
        const i = stack.pop()!;
        comp.push(i);
        const c = i % g0.cols;
        for (const j of [i - g0.cols, i + g0.cols, c > 0 ? i - 1 : -1, c < g0.cols - 1 ? i + 1 : -1])
          if (j >= 0 && cells.has(j) && !seen.has(j)) {
            seen.add(j);
            stack.push(j);
          }
      }
      if (comp.length < budget.minCells) continue;
      let x0 = Infinity,
        y0 = Infinity,
        x1 = -Infinity,
        y1 = -Infinity,
        diff = 0;
      for (const i of comp) {
        const c = i % g0.cols,
          r = (i / g0.cols) | 0;
        x0 = Math.min(x0, c);
        y0 = Math.min(y0, r);
        x1 = Math.max(x1, c + 1);
        y1 = Math.max(y1, r + 1);
        diff = Math.max(diff, cells.get(i)!);
      }
      const s = g0.cell;
      out.push({
        from,
        to,
        box: { x: x0 * s, y: y0 * s, w: (x1 - x0) * s, h: (y1 - y0) * s },
        cells: comp.length,
        diff,
      });
    }
  }
  return out.sort((a, b) => b.cells - a.cells);
}

/** What watch.ts reads of the page at each frame (pageSample, run in the page) */
export type Sample = {
  /** the rects of what is followed: cards, Sections and arrows in world units (the camera taken out), chrome in CSS px */
  rects: Record<string, [number, number, number, number]>;
  /** the camera's zoom (world units to CSS px) and where the world's (0, 0) is on screen */
  z: number;
  o: [number, number];
  /** per `keep` selector, how many of its elements are shown (in view, not hidden, opacity at least 0.5 all the way up) */
  shown: Record<string, number>;
  /** the text shown, a line per text node: its words, its box, the element it is in (a number it keeps over the frames) */
  texts: { t: string; b: Box; el: number }[];
  /** boxes not judged for flashes in this frame (watch.ts's `ignore` selectors) */
  masks: Box[];
};

/** A followed element that moved by less than `still` CSS px (on screen, at the frame's zoom) did not move; one that moved by
 *  more than `jump` px in one frame, `ratio` times more than in the frames on either side, jumped */
export const JUMP_BUDGET = { still: 0.5, jump: 3, ratio: 3 };

/** What a followed element may do in a watched action: stay where it was, move smoothly, or anything (it follows the pointer) */
export type Role = "still" | "moves" | "free";

export type JumpHit = {
  key: string;
  kind: "moved" | "jumped";
  frame: number;
  by: number;
  from: number[];
  to: number[];
};

const stepOf = (a: readonly number[], b: readonly number[], z: number) =>
  Math.max(...a.map((v, k) => Math.abs(v - b[k]))) * z;

/**
 * Over a watched action's samples (0: before it): every followed element that is to stay still and moved or changed size from
 * where it was before the action (by more than `still`), at the first frame it did; every one that moves and made one step far
 * longer than the steps around it (a jump: a box laid out in one place and moved in the next frame, then left to settle; only
 * its place counts here, since a card that gains a line grows by that line at once). Elements missing in a frame (not mounted,
 * culled, not seen) are skipped there. World rects are compared at the larger zoom of the two frames, so a still card stays
 * still while the camera moves
 */
export function jumpHits(
  samples: readonly Pick<Sample, "rects" | "z">[],
  role: (key: string) => Role,
  budget = JUMP_BUDGET,
): JumpHit[] {
  const out: JumpHit[] = [];
  if (!samples.length) return out;
  const keys = new Set(samples.flatMap((s) => Object.keys(s.rects)));
  const zOf = (key: string, s: Pick<Sample, "z">) => (key.startsWith("chrome:") ? 1 : s.z);
  for (const key of keys) {
    const r0 = role(key);
    if (r0 === "free") continue;
    if (r0 === "still") {
      const base = samples[0].rects[key];
      if (!base) continue;
      for (let f = 1; f < samples.length; f++) {
        const r = samples[f].rects[key];
        if (!r) continue;
        const by = stepOf(base, r, Math.max(zOf(key, samples[0]), zOf(key, samples[f])));
        if (by > budget.still) {
          out.push({ key, kind: "moved", frame: f, by: +by.toFixed(2), from: base, to: r });
          break;
        }
      }
      continue;
    }
    const steps: number[] = [];
    for (let f = 1; f < samples.length; f++) {
      const a = samples[f - 1].rects[key],
        b = samples[f].rects[key];
      const z = Math.max(zOf(key, samples[f - 1]), zOf(key, samples[f]));
      steps.push(a && b ? stepOf(a.slice(0, 2), b.slice(0, 2), z) : Number.NaN);
    }
    for (let i = 0; i < steps.length; i++) {
      const s = steps[i];
      if (!(s > budget.jump)) continue;
      const around = Math.max(steps[i - 1] || 0, steps[i + 1] || 0);
      if (s > budget.ratio * around) {
        out.push({
          key,
          kind: "jumped",
          frame: i + 1,
          by: +s.toFixed(2),
          from: samples[i].rects[key],
          to: samples[i + 1].rects[key],
        });
        break;
      }
    }
  }
  return out;
}

export type HandoffHit = { frame: number; t: string; from: Box; to: Box; by: number };

/**
 * A handoff that jumps: words that appear in a new element in a frame, over the same words shown by another element the frame
 * before and at about their size (within sizeRatio: a copy that takes over from the original, as the flying title of a
 * sub-board does from its breadcrumb), but not at their size (by more than `still` px: in the first frame painted after the
 * action the copy may be on its way already, so only its size counts). The words then visibly change size as the copy takes
 * over: #169's copy laid 2 % smaller than the crumb (font 12.20 px against 12.5). Frames where the camera moved are not judged.
 * Only the first `within` frames after the action: a copy takes over as the action starts, from where it was asked for. Where
 * a copy lands later depends on when the host's answer came (a board switch's init is the host's own message, not a reply
 * watch.ts can wait for), so a handoff there is not the same on every run
 */
export function handoffHits(
  samples: readonly Pick<Sample, "texts" | "z" | "o">[],
  budget = JUMP_BUDGET,
  sizeRatio = 1.25,
  within = 2,
): HandoffHit[] {
  const out: HandoffHit[] = [];
  for (let f = 1; f < Math.min(samples.length, within + 1); f++) {
    // while the camera moves every word moves, and lines coming into view take the place of others
    const p = samples[f - 1],
      q = samples[f];
    if (p.z !== q.z || p.o[0] !== q.o[0] || p.o[1] !== q.o[1]) continue;
    const before = samples[f - 1].texts;
    const old = new Set(before.map((t) => t.el));
    for (const n of samples[f].texts) {
      if (old.has(n.el)) continue;
      for (const o of before) {
        if (o.t !== n.t || o.el === n.el) continue;
        const a = o.b,
          b = n.b;
        const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x),
          h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
        if (!(w > 0 && h > 0 && w * h >= 0.5 * Math.min(a.w * a.h, b.w * b.h))) continue;
        if (Math.max(a.h, b.h) > sizeRatio * Math.min(a.h, b.h)) continue;
        // by its size: in the first frame painted after it the copy may be on its way already
        const by = Math.max(Math.abs(a.w - b.w), Math.abs(a.h - b.h));
        if (by > budget.still && !out.some((x) => x.t === n.t))
          out.push({ frame: f, t: n.t, from: a, to: b, by: +by.toFixed(2) });
      }
    }
  }
  return out;
}

export type VanishHit = { sel: string; frames: number[] };

/** A `keep` selector shown before the action and not shown in some frame of it: something that must stay on screen went away */
export function vanishHits(samples: readonly Pick<Sample, "shown">[]): VanishHit[] {
  const out: VanishHit[] = [];
  if (!samples.length) return out;
  for (const sel of Object.keys(samples[0].shown)) {
    if (!samples[0].shown[sel]) continue;
    const frames = samples.flatMap((s, f) => (s.shown[sel] ? [] : [f]));
    if (frames.length) out.push({ sel, frames });
  }
  return out;
}

export type TwiceHit = { frame: number; t: string; a: Box; b: Box };

/**
 * The same words shown twice, one over the other, for a moment: two text nodes of different elements with the same text, about
 * the same height (within sizeRatio), whose boxes overlap by at least half the smaller one, in a frame of the action but neither before it (frame 0) nor at its end (the
 * last frame), where two cards may lie over each other for good (#169: leaving a sub-board, the breadcrumb's title and its flying
 * copy, 2 % smaller, both shown for the frames the breadcrumb took to fade). A crossfade by design is left out by `ignore`
 */
export function twiceHits(samples: readonly Pick<Sample, "texts">[], overlap = 0.5, sizeRatio = 1.25): TwiceHit[] {
  const pairs = (s: Pick<Sample, "texts">) => {
    const out = new Map<string, Omit<TwiceHit, "frame">>();
    const by = new Map<string, Sample["texts"]>();
    for (const t of s.texts) {
      const l = by.get(t.t);
      if (l) l.push(t);
      else by.set(t.t, [t]);
    }
    for (const [t, l] of by)
      for (let i = 0; i < l.length; i++)
        for (let j = i + 1; j < l.length; j++) {
          if (l[i].el === l[j].el) continue;
          const a = l[i].b,
            b = l[j].b;
          const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x),
            h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
          if (!(w > 0 && h > 0 && w * h >= overlap * Math.min(a.w * a.h, b.w * b.h))) continue;
          // at about the same size: a title morphing into a heading twice its size reads as one moving, not as doubled
          if (Math.max(a.h, b.h) > sizeRatio * Math.min(a.h, b.h)) continue;
          const k = (r: Box) => `${Math.round(r.x)},${Math.round(r.y)}`;
          out.set(`${t}|${[k(a), k(b)].sort().join("|")}`, { t, a, b });
        }
    return out;
  };
  if (samples.length < 3) return [];
  const before = pairs(samples[0]),
    after = pairs(samples[samples.length - 1]);
  const out: TwiceHit[] = [];
  for (let frame = 1; frame < samples.length - 1; frame++)
    for (const [k, p] of pairs(samples[frame]))
      if (!before.has(k) && !after.has(k) && !out.some((o) => o.t === p.t)) out.push({ frame, ...p });
  return out;
}

/**
 * Runs in the page (page.evaluate(pageSample, …)): no closures, nothing imported. Cards (.card[data-id] in the world), Section
 * frames (.sect[data-sect]), arrows (path.lhit[data-link]) and the `follow` selectors (a card's lines) are read in world units from
 * the world's transform; `chrome` selectors in CSS px. Only text in view is read; `ignore` selectors' boxes are masks, and their text is not read
 */
export function pageSample(o: {
  keep: string[];
  ignore: string[];
  chrome: string[];
  follow: string[];
  texts: boolean;
}): Sample {
  const W = innerWidth,
    H = innerHeight;
  const world = document.querySelector<HTMLElement>(".world");
  const m = /translate\(([-\d.e+]+)px, ([-\d.e+]+)px\) scale\(([-\d.e+]+)\)/.exec(world?.style.transform ?? "");
  const tx = m ? +m[1] : 0,
    ty = m ? +m[2] : 0,
    z = m ? +m[3] : 1;
  // the world is at (0, 0) of its parent with its origin at 0 0: a point of it is at parent + translate + z × (its world place)
  const base = world?.parentElement?.getBoundingClientRect() ?? { left: 0, top: 0 };
  const rects: Sample["rects"] = {};
  const inWorld = (r: DOMRect): [number, number, number, number] => [
    +((r.left - base.left - tx) / z).toFixed(3),
    +((r.top - base.top - ty) / z).toFixed(3),
    +(r.width / z).toFixed(3),
    +(r.height / z).toFixed(3),
  ];

  const opacity = new Map<Element, number>();
  const opOf = (e: Element): number => {
    const k = opacity.get(e);
    if (k !== undefined) return k;
    const s = getComputedStyle(e);
    const v = s.display === "none" ? 0 : +s.opacity * (e.parentElement ? opOf(e.parentElement) : 1);
    opacity.set(e, v);
    return v;
  };
  // what is not seen (faded out, hidden while it waits for its entrance) has no place in this frame
  const seen = (e: Element) => opOf(e) >= 0.05 && getComputedStyle(e).visibility === "visible";
  if (world) {
    for (const c of world.querySelectorAll<HTMLElement>(".card[data-id]")) {
      if (c.closest(".lay.gone") || !seen(c)) continue;
      const r = c.getBoundingClientRect();
      if (r.width && r.height) rects[`card:${c.dataset.id}`] = inWorld(r);
    }
    for (const c of world.querySelectorAll<HTMLElement>(".sect[data-sect]")) {
      if (!seen(c)) continue;
      const r = c.getBoundingClientRect();
      if (r.width && r.height) rects[`sect:${c.dataset.sect}`] = inWorld(r);
    }
    for (const p of world.querySelectorAll<SVGPathElement>("path.lhit[data-link]")) {
      if (opOf(p) < 0.05) continue;
      const r = p.getBoundingClientRect();
      if (r.width || r.height) rects[`link:${p.dataset.link}`] = inWorld(r);
    }
  }
  for (const sel of o.follow)
    document.querySelectorAll(sel).forEach((e, i) => {
      const r = e.getBoundingClientRect();
      if (r.width && r.height && seen(e)) rects[`el:${sel}#${i}`] = inWorld(r);
    });
  for (const sel of o.chrome)
    document.querySelectorAll(sel).forEach((e, i) => {
      const r = e.getBoundingClientRect();
      if (r.width && r.height && seen(e))
        rects[`chrome:${sel}#${i}`] = [
          +r.left.toFixed(3),
          +r.top.toFixed(3),
          +r.width.toFixed(3),
          +r.height.toFixed(3),
        ];
    });
  const shownEl = (e: Element) => {
    const r = e.getBoundingClientRect();
    return (
      r.width > 0 &&
      r.height > 0 &&
      r.right > 0 &&
      r.bottom > 0 &&
      r.left < W &&
      r.top < H &&
      getComputedStyle(e).visibility === "visible" &&
      opOf(e) >= 0.5
    );
  };
  const shown: Sample["shown"] = {};
  for (const sel of o.keep) shown[sel] = [...document.querySelectorAll(sel)].filter(shownEl).length;
  const masks: Box[] = [];
  // what a running animation moves (a flying copy, a sliding panel) is motion by design, like a card that moved
  // (offset-path and friends, not the `offset` / `computedOffset` keys every keyframe from getKeyframes() carries)
  const MOVES = /^(transform|translate|scale|rotate|left|top|right|bottom|width|height|inset|offset[A-Z-])/;
  const KEYFRAME_KEYS = new Set(["offset", "computedOffset", "easing", "composite"]);
  for (const a of document.getAnimations()) {
    const e = a.effect as KeyframeEffect | null;
    if (a.playState !== "running" || !e?.target) continue;
    const props =
      a instanceof CSSTransition
        ? [a.transitionProperty]
        : e.getKeyframes().flatMap((k) => Object.keys(k).filter((p) => !KEYFRAME_KEYS.has(p)));
    if (!props.some((p) => MOVES.test(p))) continue;
    const r = e.target.getBoundingClientRect();
    if (r.width && r.height) masks.push({ x: r.left, y: r.top, w: r.width, h: r.height });
  }
  for (const sel of o.ignore)
    for (const e of document.querySelectorAll(sel)) {
      const r = e.getBoundingClientRect();
      if (r.width && r.height) masks.push({ x: r.left, y: r.top, w: r.width, h: r.height });
    }
  const texts: Sample["texts"] = [];
  if (o.texts) {
    // an element keeps its number from frame to frame (kept on the page), so a text can be followed from one element to another
    const w = window as unknown as { __watchIds?: WeakMap<Element, number>; __watchN?: number };
    const els = (w.__watchIds ??= new WeakMap());
    const skip = o.ignore.join(",");
    const tw = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    const range = document.createRange();
    for (let n = tw.nextNode(); n; n = tw.nextNode()) {
      const t = (n.textContent ?? "").trim();
      const el = n.parentElement;
      if (t.length < 2 || !el || !/[\p{L}\p{N}]/u.test(t)) continue;
      range.selectNodeContents(n);
      const r = range.getBoundingClientRect();
      if (!(r.width > 0 && r.height > 0 && r.right > 0 && r.bottom > 0 && r.left < W && r.top < H)) continue;
      if ((skip && el.closest(skip)) || getComputedStyle(el).visibility !== "visible" || opOf(el) < 0.2) continue;
      if (!els.has(el)) els.set(el, (w.__watchN = (w.__watchN ?? 0) + 1));
      texts.push({ t, b: { x: r.left, y: r.top, w: r.width, h: r.height }, el: els.get(el)! });
    }
  }
  return { rects, z, o: [base.left + tx, base.top + ty], shown, texts, masks };
}

// ---- consistency matrix (card-kinds.spec.ts): the parts every kind of card shares, read from the computed style of each kind in
// one theme; judged here

/** One kind of card's shared parts in one theme and mode (null: the kind has no such part) */
export type KindLook = { kind: string; parts: Record<string, string | null> };

/** A difference let through, with why: part and kind, optionally only in some themes ("warm-ink", "ink-wash dark") */
export type AllowEntry = { part: string; kind: string; in?: string; why: string };

export type StyleHit = { theme: string; part: string; kind: string; value: string; most: string; others: string[] };

/**
 * For each shared part, the value most kinds have in this theme, and every kind whose value differs and is not allowed: a part
 * that looks one way on most cards and another on a few (#158: Warm Ink's header line only on code cards). A tie is judged
 * against the value of the first kind listed (the code card, the board's main kind). Kinds without the part are left out
 */
export function styleHits(theme: string, looks: readonly KindLook[], allow: readonly AllowEntry[]): StyleHit[] {
  const out: StyleHit[] = [];
  const parts = [...new Set(looks.flatMap((l) => Object.keys(l.parts)))];
  for (const part of parts) {
    const has = looks.filter((l) => l.parts[part] != null);
    const count = new Map<string, number>();
    for (const l of has) count.set(l.parts[part]!, (count.get(l.parts[part]!) ?? 0) + 1);
    let most = has[0]?.parts[part] ?? "";
    for (const [v, n] of count) if (n > count.get(most)!) most = v;
    for (const l of has) {
      const value = l.parts[part]!;
      if (value === most) continue;
      if (allow.some((a) => a.part === part && a.kind === l.kind && (!a.in || theme.startsWith(a.in)))) continue;
      out.push({
        theme,
        part,
        kind: l.kind,
        value,
        most,
        others: has.filter((k) => k.parts[part] === most).map((k) => k.kind),
      });
    }
  }
  return out;
}

/** Allow-list entries that no longer let anything through in the themes judged: a difference fixed, or a rule that went stale */
export function unusedAllows(
  judged: readonly { theme: string; looks: readonly KindLook[] }[],
  allow: readonly AllowEntry[],
): AllowEntry[] {
  return allow.filter(
    (a) =>
      !judged.some(
        ({ theme, looks }) =>
          (!a.in || theme.startsWith(a.in)) &&
          styleHits(
            theme,
            looks,
            allow.filter((b) => b !== a),
          ).some((h) => h.part === a.part && h.kind === a.kind),
      ),
  );
}
