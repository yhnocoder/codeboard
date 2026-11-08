// The routing bundle (build.mjs → router.js): core's arrow routing alone, for the shell's second JavaScript context on a background
// thread (RouteWorker.swift). During a drag the shell posts the moved cards' rectangles here every frame and draws the latest
// finished routes; the main context never routes mid-drag. `setModel` gets the routing model from each Scene / SceneChange.
import { type RouteModel, Router, shellGeo } from "./routes";

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
  route: (key: string, rects: string, only?: string) => {
    const e = routers.get(key);
    return e
      ? str(e.router.route(e.model, JSON.parse(rects), only ? JSON.parse(only) : undefined).map(shellGeo))
      : "[]";
  },
};
