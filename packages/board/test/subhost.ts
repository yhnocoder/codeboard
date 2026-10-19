// A host for sub-board scenarios (subboards.spec.ts, boards.spec.ts): core Storage on a temp dir, switching one board panel
// between boards like Panels.switchBoard (crumbs, cameras, walkthrough hops) and pushing skeletons after saves (120 ms debounce).
import * as fs from "node:fs";
import * as path from "node:path";
import { DEFAULT_SETTINGS, cutCrumbs, skeletonOf, subBoardsOf, wouldCycle, type Board, type Camera, type Crumb, type Skeleton, type SegView, type HostToBoard } from "@codeboard/core";
import { Storage } from "@codeboard/core/storage";
import { nodeFs } from "../../../extensions/vscode/src/nodefs";
import { viewOf, OUT, type Host } from "./harness";
import { open, light } from "./fixtures";

const viewsOf = (b: Board): Record<string, SegView> => {
  const v: Record<string, SegView> = {};
  for (const c of b.cards) if (c.kind === "code") for (const s of c.segments) v[s.id] = viewOf(s);
  return v;
};

/** A host for one board panel that switches between boards */
export async function subHost(start: Board, others: Board[]) {
  const dir = path.join(OUT, `subboards-store-${process.pid}-${start.id}`); // one per worker and start board: workers run side by side
  fs.rmSync(dir, { recursive: true, force: true });
  const store = new Storage(nodeFs, { dir: () => dir });
  for (const b of [start, ...others]) await store.save(b);
  let cur = start.id, crumbs: Crumb[] = [], cams: Camera[] = [];
  const inits: { id: string; crumbs: number; walk?: unknown }[] = [];
  let h!: Host; // a patch can come in before open() returns (the first skeletons mark lost arrows): h?.post there (init() pushes the skeletons again)
  const sent = new Map<string, string>();
  const sk = (id: string): Skeleton | null => { const b = store.peek(id); return b ? skeletonOf(b, (x) => store.peek(x)?.name) : null; };
  const dirty = new Set<string>();
  let all = false, t: ReturnType<typeof setTimeout> | undefined;
  const push = () => {
    clearTimeout(t);
    t = setTimeout(() => {
      const b = store.peek(cur);
      if (!b) return;
      const out: Record<string, Skeleton | null> = {};
      for (const id of subBoardsOf(b)) {
        if (sent.has(id) && !all && !dirty.has(id)) continue;
        const s = sk(id), k = JSON.stringify(s);
        if (sent.get(id) === k) continue;
        sent.set(id, k); out[id] = s;
      }
      dirty.clear(); all = false;
      if (Object.keys(out).length) void h?.post({ type: "skeletons", boards: out });
    }, 120);
  };
  store.onDidSave((b) => { dirty.add(b.id); push(); });
  // like Panels: a deleted board on the breadcrumbs can't be gone back to
  store.onDidRemoveBoard((id) => { const c = cutCrumbs(crumbs, cams, id); if (c) { crumbs = c.crumbs; cams = c.cams; void h.post({ type: "crumbs", crumbs }); } });
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
    board: (await store.load(cur))!, light, w: 1400, h: 900,
    on: async (m, reply) => {
      switch (m.type) {
        case "patch": await store.patch(cur, m.patch, { undo: m.undo }); await h?.post({ type: "boards", boards: await store.list() }); await reply(m.req, { skipped: 0 }); return true;
        case "skeletons": await store.list(); await reply(m.req, Object.fromEntries(m.ids.map((id) => [id, sk(id)]))); return true;
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
          cur = m.id; await init(m.walk); return true;
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
  await init(); // the harness's own init has no board list / skeleton push yet
  return { store, h, inits, cur: () => cur, crumbs: () => crumbs };
}
