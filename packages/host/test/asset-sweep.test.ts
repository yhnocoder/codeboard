import * as fs from "node:fs";
import * as path from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { emptyBoard, type NoteCard } from "@codeboard/core";
import { Storage } from "@codeboard/core/storage";
import { nodeFs } from "../src/nodefs";
import { ASSET_MAX_AGE, SWEEP_EVERY, sweepAssets } from "../src/assetsweep";
import { useWorkspace } from "../src/ws";
import { nodeWorkspace } from "./node-workspace";

const tmp = fs.mkdtempSync("/tmp/codeboard-sweep-");
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));
const state = new Map<string, unknown>();
beforeEach(() => { state.clear(); useWorkspace({ ...nodeWorkspace(), storage: { dir: () => tmp, globalDir: () => tmp, get: <T>(k: string) => state.get(k) as T | undefined, set: async (k: string, v: unknown) => { state.set(k, v); } } }); });

const NOW = Date.now();
let n = 0;
function setup() {
  const dir = path.join(tmp, `s${++n}`);
  const store = new Storage(nodeFs, { dir: () => dir });
  const asset = (name: string, ageDays: number) => {
    const p = path.join(dir, "assets", name);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, "x");
    const t = new Date(NOW - ageDays * 24 * 3600 * 1000);
    fs.utimesSync(p, t, t);
  };
  const json = (rel: string, v: unknown) => { const p = path.join(dir, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, JSON.stringify(v)); };
  const left = () => fs.readdirSync(path.join(dir, "assets")).sort();
  return { dir, store, asset, json, left };
}
const note = (id: string, md: string): NoteCard => ({ id, kind: "note", md, look: "note" });

describe("sweeping unused images", () => {
  it("deletes an unreferenced image older than 7 days and keeps referenced and recent ones", async () => {
    const { store, asset, json, left } = setup();
    asset("aaaaaaaaaaaaaaaa-10x10.png", 30); // referenced by a Note
    asset("bbbbbbbbbbbbbbbb-10x10.png", 30); // unreferenced, old
    asset("cccccccccccccccc-10x10.png", 2); // unreferenced, pasted 2 days ago (maybe undone, maybe redone later)
    asset("dddddddddddddddd.png", 30); // an Image card's src (bare file name)
    json("b1.json", { ...emptyBoard("b1", "one"), cards: [note("n", "see ![](assets/aaaaaaaaaaaaaaaa-10x10.png)"), { id: "i", kind: "image", src: "dddddddddddddddd.png" }] });
    expect(await sweepAssets(store, { now: NOW })).toEqual(["bbbbbbbbbbbbbbbb-10x10.png"]);
    expect(left()).toEqual(["aaaaaaaaaaaaaaaa-10x10.png", "cccccccccccccccc-10x10.png", "dddddddddddddddd.png"]);
  });

  it("keeps images referenced from another board in a group, a shared card, the trash, or only an open board's unsaved state", async () => {
    const { store, asset, json, left } = setup();
    for (const k of ["1", "2", "3", "4"]) asset(`${k.repeat(16)}-1x1.png`, 30);
    json("group/b2.json", { ...emptyBoard("b2", "two"), cards: [note("n", "![](assets/1111111111111111-1x1.png)")] });
    json("cards/n9.json", { version: 8, card: note("n9", "![x](assets/2222222222222222-1x1.png)"), sidenotes: [] });
    json(".trash/b3.json", { ...emptyBoard("b3", "deleted"), cards: [note("n", "![](assets/3333333333333333-1x1.png)")] });
    const b = { ...emptyBoard("b4", "open"), cards: [note("n", "")] };
    await store.save(b);
    await store.load("b4");
    (store.peek("b4")!.cards[0] as NoteCard).md = "![](assets/4444444444444444-1x1.png)"; // edited, not written yet
    expect(await sweepAssets(store, { now: NOW })).toEqual([]);
    expect(left()).toHaveLength(4);
  });

  it("runs at most once a day per storage folder", async () => {
    const { store, asset } = setup();
    expect(await sweepAssets(store, { now: NOW })).toEqual([]);
    asset("eeeeeeeeeeeeeeee-1x1.png", 30);
    expect(await sweepAssets(store, { now: NOW + SWEEP_EVERY - 1000 })).toEqual([]); // too soon
    expect(await sweepAssets(store, { now: NOW + SWEEP_EVERY + 1000 })).toEqual(["eeeeeeeeeeeeeeee-1x1.png"]);
    // another storage folder has its own day
    const other = setup();
    other.asset("ffffffffffffffff-1x1.png", 30);
    expect(await sweepAssets(other.store, { now: NOW + SWEEP_EVERY + 2000 })).toEqual(["ffffffffffffffff-1x1.png"]);
  });

  it("deletes nothing when a board file can't be read", async () => {
    const { dir, store, asset, json, left } = setup();
    asset("gggggggggggggggg-1x1.png", 30);
    json("b1.json", emptyBoard("b1", "one"));
    fs.chmodSync(path.join(dir, "b1.json"), 0o000);
    const readable = (() => { try { fs.readFileSync(path.join(dir, "b1.json")); return true; } catch { return false; } })();
    await sweepAssets(store, { now: NOW }).catch(() => []);
    fs.chmodSync(path.join(dir, "b1.json"), 0o644);
    if (!readable) expect(left()).toEqual(["gggggggggggggggg-1x1.png"]); // as root every file is readable: nothing to check
    expect(ASSET_MAX_AGE).toBe(7 * 24 * 3600 * 1000);
  });
});
