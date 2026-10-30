// A host for sub-board scenarios (subboards.spec.ts, boards.spec.ts): core Storage on a temp dir, switching one board panel
// between boards like BoardHub.switchBoard (crumbs, cameras, walkthrough hops) and pushing skeletons after saves (120 ms debounce).
import * as fs from "node:fs";
import * as path from "node:path";
import { DEFAULT_SETTINGS, cardPath, cutCrumbs, isCode, skeletonOf, subCardOf, subBoardsOf, wouldCycle, type Board, type Camera, type Crumb, type Skeleton, type SegView, type HostToBoard } from "@codeboard/core";
import { Storage } from "@codeboard/core/storage";
import { nodeFs } from "@codeboard/host/nodefs";
import { viewOf, OUT, type Host } from "./harness";
import { open, light } from "./fixtures";

const viewsOf = (b: Board): Record<string, SegView> => {
  const v: Record<string, SegView> = {};
  for (const c of b.cards) if (c.kind === "code") for (const s of c.segments) v[s.id] = viewOf(s);
  return v;
};

/** o.light: this scenario's theme whatever HARNESS_LIGHT says (for one that compares colours with a light design) */
export async function subHost(start: Board, others: Board[], o: { light?: boolean } = {}) {
  const dir = path.join(OUT, `subboards-store-${process.pid}-${start.id}`); // one per worker and start board: workers run side by side
  fs.rmSync(dir, { recursive: true, force: true });
  const store = new Storage(nodeFs, { dir: () => dir });
  for (const b of [start, ...others]) await store.save(b);
  let cur = start.id, crumbs: Crumb[] = [], cams: Camera[] = [];
  const inits: { id: string; crumbs: number; walk?: unknown }[] = [];
  let h!: Host; // a patch can come in before open() returns (the first skeletons mark lost arrows): h?.post there (init() pushes the skeletons again)
  const sent = new Map<string, string>();
  const sk = (id: string): Skeleton | null => { const b = store.peek(id); return b ? skeletonOf(b, (x) => store.peek(x)) : null; };
  // a push the host starts on its own (debounced skeletons, crumbs): once the scenario has closed the page it goes nowhere. Without
  // this, a push timed after a scenario that ends right after its last save rejects in the next scenario of the worker
  const pushed = (m: HostToBoard) => {
    if (!h || h.page.isClosed()) return;
    h.post(m).catch((e) => { if (!h.page.isClosed()) throw e; });
  };
  const dirty = new Set<string>();
  let all = false, t: ReturnType<typeof setTimeout> | undefined;
  // like BoardHub: a skeleton lists the [[-linkable cards of the boards further down too, so a save below a frame's board redoes it
  const touched = (id: string, seen = new Set<string>()): boolean => {
    if (dirty.has(id)) return true;
    if (seen.has(id)) return false;
    seen.add(id);
    const b = store.peek(id);
    return !!b && subBoardsOf(b).some((x) => touched(x, seen));
  };
  const push = () => {
    clearTimeout(t);
    t = setTimeout(() => {
      const b = store.peek(cur);
      if (!b) return;
      const out: Record<string, Skeleton | null> = {};
      for (const id of subBoardsOf(b)) {
        if (sent.has(id) && !all && !touched(id)) continue;
        const s = sk(id), k = JSON.stringify(s);
        if (sent.get(id) === k) continue;
        sent.set(id, k); out[id] = s;
      }
      dirty.clear(); all = false;
      if (Object.keys(out).length) pushed({ type: "skeletons", boards: out });
    }, 120);
  };
  store.onDidSave((b) => { dirty.add(b.id); push(); });
  // like BoardHub: a deleted board on the breadcrumbs can't be gone back to
  store.onDidRemoveBoard((id) => { const c = cutCrumbs(crumbs, cams, id); if (c) { crumbs = c.crumbs; cams = c.cams; pushed({ type: "crumbs", crumbs }); } });
  store.onDidChange(() => { all = true; push(); });
  const init = async (walk?: unknown, cam?: Camera) => {
    const b = (await store.load(cur))!;
    if (cam) b.cam = cam;
    sent.clear();
    inits.push({ id: cur, crumbs: crumbs.length, walk });
    const m: HostToBoard = { type: "init", board: b, boards: await store.list(), views: viewsOf(b), stale: {}, host: { isMac: true, assetBase: "", target: true, settings: DEFAULT_SETTINGS } };
    if (crumbs.length) m.crumbs = crumbs;
    if (walk) m.walk = walk as any;
    await h.post(m);
    push();
  };
  h = await open({
    board: (await store.load(cur))!, light: o.light ?? light, w: 1400, h: 900,
    on: async (m, reply) => {
      switch (m.type) {
        case "patch": await store.patch(cur, m.patch, { undo: m.undo }); await h?.post({ type: "boards", boards: await store.list() }); await reply(m.req, { skipped: 0 }); return true;
        case "skeletons": await store.list(); await reply(m.req, Object.fromEntries(m.ids.map((id) => [id, sk(id)]))); return true;
        case "subCard": {
          const b = store.peek(m.board), r = b && subCardOf(b, m.card), views: Record<string, SegView> = {};
          for (const c of r ? [r.card, ...(r.cols ?? [])] : []) if (isCode(c)) for (const s of c.segments) views[s.id] = viewOf(s);
          await reply(m.req, r ? { ...r, views } : null); return true;
        }
        case "newBoard": await store.save(m.board, { group: null }); await reply(m.req, true); return true;
        case "deleteBoard": await store.remove(m.id); await reply(m.req, true); return true;
        case "dropBoard": {
          const framed = (await store.list()).some((x) => x.id !== cur && x.subs?.includes(m.id));
          await reply(m.req, !framed && (await store.dropIfUnchanged(m.id, m.made))); return true;
        }
        case "restoreBoard": await reply(m.req, await store.restore(m.id)); return true;
        case "confirm": await reply(m.req, true); return true;
        case "enterBoard": {
          const metas = await store.list();
          if (wouldCycle((id) => metas.find((x) => x.id === id)?.subs, cur, m.id)) return true;
          crumbs = [...crumbs, { id: cur, name: store.peek(cur)!.name, frame: m.frame }]; cams = [...cams, m.cam];
          cur = m.id;
          // like the host's enterBoard: a card further down is reached through every board on the way (each one on the crumbs)
          for (const hop of (m.reveal && cardPath(store.peek(cur)!, m.reveal, (id) => store.peek(id))) || []) {
            const at = store.peek(cur)!;
            crumbs = [...crumbs, { id: cur, name: at.name, frame: hop.frame }]; cams = [...cams, at.cam];
            cur = hop.board;
          }
          await init(m.walk);
          if (m.reveal) await h.post({ type: "reveal", card: m.reveal });
          return true;
        }
        case "leaveBoard": {
          if (!crumbs.length) return true;
          const d = m.depth ?? crumbs.length - 1;
          const to = crumbs[d], cam = cams[d];
          crumbs = crumbs.slice(0, d); cams = cams.slice(0, d); cur = to.id;
          await init(m.walk, cam); return true;
        }
        default: return false;
      }
    },
  });
  // like BoardHub when a panel closes: the store writes what it still holds (it writes patches WRITE_DELAY later). The test's
  // teardown awaits h.close(), so no write of this store is left over for the next scenario of the worker, whose subHost uses this dir
  const close = h.close;
  h.close = async () => { await close(); await store.flush(); };
  await init(); // the harness's own init has no board list / skeleton push yet
  return { store, h, inits, cur: () => cur, crumbs: () => crumbs };
}
