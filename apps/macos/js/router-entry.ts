// The routing bundle (build.mjs → router.js): core's arrow routing alone, for the shell's second JavaScript context on a background
// thread (RouteWorker.swift). During a drag the shell posts the moved cards' rectangles here every frame and draws the latest
// finished routes; the main context never routes mid-drag. `setModel` gets the routing model from each Scene / SceneChange.
// The same bundle, in a context of the shell's own (Ink.swift), draws Ink Wash's paper and brush frames with core's maths.
import {
  acrossCut,
  drainStep,
  framePath,
  levelFor,
  paperSheet,
  pushed,
  pushStep,
  DRAIN_AFTER,
  SWITCH_COVER,
  SWITCH_MS,
  switching,
  towardCut,
} from "@codeboard/core/canvas";
import { summaryMinZoom } from "@codeboard/core";
import { type RouteModel, Router, setLook, shellGeo } from "./routes";

const routers = new Map<string, { model: RouteModel; router: Router }>();
const str = (x: unknown) => JSON.stringify(x ?? null);

(globalThis as unknown as { CodeRouter: unknown }).CodeRouter = {
  /** key = folder + board */
  setModel: (key: string, model: string) => {
    const e = routers.get(key);
    if (e) e.model = JSON.parse(model);
    else routers.set(key, { model: JSON.parse(model), router: new Router() });
  },
  drop: (key: string) => void routers.delete(key),
  setLook,
  // Ink Wash's drawings, the same maths the board draws (core canvas inkpaper.ts, inkframe.ts): the torn paper sheet of an edge
  // pattern, light or dark; a Section's brush frame for a size, seed and title gap
  paperSheet: (dark: boolean, seed: number) => str(paperSheet(dark, seed)),
  brushFrame: (w: number, h: number, seed: number, gap: number) => framePath(w, h, seed, gap),
  // the summary cut's detent and switch (core canvas/detent.ts), the same rules the board's state/summary.ts runs
  detent: () => str({ ms: SWITCH_MS, cover: SWITCH_COVER, drainAfter: DRAIN_AFTER }),
  levelFor,
  towardCut,
  pushStep,
  pushed: (q: number, to: number) => str(pushed(q, to as 0 | 1)),
  drainStep,
  switching: (t: number, mist0: number, to: number) => str(switching(t, mist0, to as 0 | 1)),
  acrossCut,
  summaryMinZoom: (w: number, h: number, content: string) => summaryMinZoom({ w, h }, JSON.parse(content)),
  route: (key: string, rects: string, only?: string) => {
    const e = routers.get(key);
    return e
      ? str(e.router.route(e.model, JSON.parse(rects), only ? JSON.parse(only) : undefined).map(shellGeo))
      : "[]";
  },
};
