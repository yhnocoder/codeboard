// What the host computed for each segment: its view (highlighted lines, calls, definitions; by segment id, a Variant not shown by
// viewKey) and its version state. They live in `state.views` / `state.stale`; only this file writes them (a unit test checks).
// Views are a cache by segment id: a new board drops the ones it has no segment for; segments an undo step brings back (left
// before a board switch) are asked for again
import { batch } from "solid-js";
import { produce, reconcile } from "solid-js/store";
import { boardSegments, variantSegments, type Board, type Segment, type SegView, type Stale } from "@codeboard/core";
import { ask } from "../host";
import { setState, state } from "./store";

/** Add or replace views */
export function putViews(v: Record<string, SegView>) {
  if (Object.keys(v).length) setState("views", v);
}
/** Views under new segment ids (from → to), for the ones there are */
export function copyViews(ids: Record<string, string>, from: Record<string, SegView> = state.views) {
  const out: Record<string, SegView> = {};
  for (const [o, n] of Object.entries(ids)) if (from[o]) out[n] = from[o];
  putViews(out);
}
/** Segments the board made itself (a merge, a Free code edit) or got back (undo): the host computes their views */
export async function requestViews(segs: Segment[]) {
  if (!segs.length) return;
  const v = await ask("views", { segs }).catch(() => null);
  if (v) putViews(v);
}
/** The segments on the board (Variants not shown included) that have no view yet: asked for */
export function requestMissing(b: Board) {
  requestViews([...boardSegments(b), ...variantSegments(b)].filter((s) => !state.views[s.id]));
}

/** Version states by segment (undefined = none) */
export function putStale(s: Record<string, Stale | undefined>) {
  if (Object.keys(s).length) setState("stale", s);
}
/** These segments are up to date */
export const staleOk = (ids: string[]) => putStale(Object.fromEntries(ids.map((id) => [id, { state: "ok" as const }])));

/** A new board: its views (the cached ones it has no segment for are dropped) and version states replace the old ones */
export function resetSegs(views: Record<string, SegView>, stale: Record<string, Stale>) {
  batch(() => {
    const gone = Object.keys(state.views).filter((k) => !(k in views));
    if (gone.length)
      setState(
        "views",
        produce((v) => {
          for (const k of gone) delete v[k];
        }),
      );
    setState("views", views);
    setState("stale", reconcile(stale));
  });
}
