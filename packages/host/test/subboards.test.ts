// Sub-boards: entering / leaving switches the same panel (breadcrumbs, cameras and walkthrough hops carried over), a board can't
// contain itself, Turn into Board saves into the parent's group, and the sidebar nests child boards under their parents
import * as fs from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { emptyBoard, skeletonOf, type Board, type BoardToHost, type Camera, type Crumb, type WalkHop } from "@codeboard/core";
import { Storage } from "@codeboard/core/storage";
import { nodeFs } from "../src/nodefs";
import { makeHandler } from "../src/handlers";
import { BoardPanel, type BoardHost } from "../src/boards";
import { treeChildren } from "../src/boardtree";
import { useWorkspace } from "../src/ws";
import { nodeWorkspace } from "./node-workspace";
import { stubView } from "./helpers";

const dir = fs.mkdtempSync("/tmp/codeboard-sub-");
const store = new Storage(nodeFs, { dir: () => dir });
const switches: { to: string; crumbs: Crumb[]; cams: Camera[]; walk?: WalkHop; cam?: Camera }[] = [];
const { view, posted } = stubView();
const toasts = () => posted.flatMap((m) => (m.type === "toast" ? [m.text] : []));
const panels: BoardHost = {
  store, target: undefined, clip: undefined,
  get: () => undefined, all: () => [], metas: () => store.list(), show: async () => undefined, setTarget: () => undefined, broadcast: () => undefined,
  pushBoards: async () => undefined, staleChanged: () => undefined, refreshStale: async () => undefined, refreshShared: () => undefined, refreshSkeletons: () => undefined,
  skeleton: (id) => { const b = store.peek(id); return b ? skeletonOf(b, (x) => store.peek(x)) : null; },
  switchBoard: async (p, to, o) => { switches.push({ to, ...o }); p.id = to; p.crumbs = o.crumbs; p.cams = o.cams; return true; },
};
const p = new BoardPanel("bE", view, panels);
const send = (m: BoardToHost) => makeHandler(panels)(p, m);
let E: Board, S: Board, X: Board;

beforeAll(async () => {
  useWorkspace(nodeWorkspace());
  E = emptyBoard("bE", "Engine"); S = emptyBoard("bS", "Scheduler"); X = emptyBoard("bX", "Other");
  E.cards.push({ id: "f", kind: "board", board: "bS" }); E.place.f = { x: 0, y: 0, w: 560, h: 360 };
  S.cards.push({ id: "n", kind: "note", md: "hi", bg: true }); S.place.n = { x: 0, y: 0, w: 200 };
  await store.save(E, { group: "g1" }); await store.save(S); await store.save(X);
  p.ready = true;
  p.board = store.peek("bE");
});
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

describe("sub-boards", () => {
  it("sends the child board's skeleton, null for a missing board", async () => {
    const sk = await send({ type: "skeletons", req: 1, ids: ["bS", "nope"] }) as Record<string, { n: number } | null>;
    expect(sk.bS?.n).toBe(1);
    expect(sk.nope).toBeNull();
  });
  it("enters the child in the same panel with a breadcrumb, the parent camera and the walkthrough hop", async () => {
    await send({ type: "enterBoard", id: "bS", frame: "f", cam: { x: 1, y: 2, z: 0.5 }, walk: { into: { root: "r", i: 2 } } });
    expect(p.id).toBe("bS");
    expect(switches[0].crumbs).toEqual([{ id: "bE", name: "Engine", frame: "f" }]);
    expect(switches[0].cams[0].z).toBe(0.5);
    expect(switches[0].walk).toEqual({ into: { root: "r", i: 2 } });
  });
  it("refuses to enter a cycle", async () => {
    // the parent placed inside the child: the board refuses first, the host checks again on entering
    S.cards.push({ id: "g", kind: "board", board: "bE" }); S.place.g = { x: 0, y: 400, w: 560, h: 360 };
    await send({ type: "enterBoard", id: "bE", frame: "g", cam: { x: 0, y: 0, z: 1 } });
    expect(switches).toHaveLength(1);
    expect(toasts().at(-1)).toMatch(/inside itself/);
  });
  it("leaves back to the parent with its camera and the walkthrough resume", async () => {
    await send({ type: "leaveBoard", walk: { resume: { root: "r", i: 3 } } });
    expect(p.id).toBe("bE");
    expect(switches[1].crumbs).toEqual([]);
    expect(switches[1].cam?.z).toBe(0.5);
    expect(switches[1].walk?.resume?.i).toBe(3);
  });
  it("enters through every board on the way to a [[ linked card further down, each one on the crumbs, and reveals the card", async () => {
    const T = emptyBoard("bT", "Top"), U = emptyBoard("bU", "Mid"), V = emptyBoard("bV", "Deep");
    T.cards.push({ id: "fu", kind: "board", board: "bU" }); T.place.fu = { x: 0, y: 0, w: 560, h: 360 };
    U.cards.push({ id: "fv", kind: "board", board: "bV" }); U.place.fv = { x: 0, y: 0, w: 560, h: 360 }; U.cam = { x: 7, y: 8, z: 0.75 };
    V.cards.push({ id: "v1", kind: "note", md: "# deep", bg: true }); V.place.v1 = { x: 0, y: 0, w: 200 };
    for (const b of [T, U, V]) await store.save(b);
    const q = new BoardPanel("bT", view, panels);
    q.ready = true; q.board = store.peek("bT");
    const before = posted.length;
    await makeHandler(panels)(q, { type: "enterBoard", id: "bU", frame: "fu", cam: { x: 1, y: 2, z: 1 }, reveal: "v1" });
    expect(switches.at(-1)).toMatchObject({ to: "bV", crumbs: [{ id: "bT", name: "Top", frame: "fu" }, { id: "bU", name: "Mid", frame: "fv" }] });
    expect(switches.at(-1)!.cams).toEqual([{ x: 1, y: 2, z: 1 }, { x: 7, y: 8, z: 0.75 }]);
    expect(posted.slice(before)).toContainEqual({ type: "reveal", card: "v1" });
  });
  it("saves Turn into Board's new board in the parent's group", async () => {
    const nb = emptyBoard("bN", "New"); nb.cards.push({ id: "c1", kind: "note", md: "x", bg: true }); nb.place.c1 = { x: 80, y: 80, w: 200 };
    expect(await send({ type: "newBoard", req: 2, board: nb })).toBe(true);
    expect(store.groupOf("bN")).toBe("g1");
    expect((await store.load("bN"))?.cards).toHaveLength(1);
  });
  it("nests child boards under their parents in the sidebar, under each parent", async () => {
    const metas = await store.list();
    const top = treeChildren(metas, ["g1"]);
    const g1 = treeChildren(metas, ["g1"], top.find((n) => n.kind === "group"));
    const kids = treeChildren(metas, [], g1.find((n) => n.kind === "board" && n.id === "bE")!);
    const boards = (ns: typeof top) => ns.flatMap((n) => (n.kind === "board" ? [n.id] : []));
    expect(boards(top)).toContain("bX");
    expect(boards(top)).not.toContain("bS");
    expect(kids.map((n) => n.kind === "board" && `${n.id} ${n.path.join("/")}`)).toEqual(["bS bE/bS"]);
    // the same board under a second parent
    X.cards.push({ id: "h", kind: "board", board: "bS" }); X.place.h = { x: 0, y: 0, w: 560, h: 360 };
    await store.save(X);
    const m2 = await store.list();
    const ox = treeChildren(m2, ["g1"]).find((n) => n.kind === "board" && n.id === "bX")!;
    expect(boards(treeChildren(m2, [], ox))).toContain("bS");
  });
});
