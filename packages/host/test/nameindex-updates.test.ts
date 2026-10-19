// The name index on nano-vllm: a lookup doesn't wait for the whole index and gives the same entries as a full scan; created, changed,
// saved and deleted files update just that file; the background build yields between files
import * as fs from "node:fs";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Disposable } from "@codeboard/core";
import { analysisOf } from "../src/analysis";
import { allNames, lookupName, nameIndexReady, resetIndex, startNameIndex, watchNameIndex, type IndexEntry } from "../src/nameindex";
import { useWorkspace } from "../src/ws";
import { WS, nodeWorkspace } from "./node-workspace";
import { startTreeSitter } from "./helpers";

const W = nodeWorkspace();
const key = (es: IndexEntry[]) => es.map((e) => `${e.abs}:${e.qual}:${e.defLine}`);
const probe = path.join(WS, "nanovllm/zz_index_probe.py");
let full: Map<string, string[]>, finds: number, watch: Disposable;

beforeAll(async () => {
  useWorkspace(W);
  await startTreeSitter();
  watch = watchNameIndex();
  resetIndex();
  finds = W.finds;
  full = new Map();
  for (const f of await W.files.findFiles("**/*.{py,pyi,cu,cuh,cc,cpp,cxx,c,h,hpp}")) for (const s of analysisOf("python", fs.readFileSync(f, "utf8")).symbols) (full.get(s.name) ?? full.set(s.name, []).get(s.name)!).push(`${f}:${s.qual}:${s.defLine}`);
});
afterAll(() => { watch.dispose(); fs.rmSync(probe, { force: true }); W.open.clear(); });

describe("name index", () => {
  it("finds a name before the index is built, the same definitions as a full scan", async () => {
    expect(key(await lookupName("Scheduler"))).toEqual(full.get("Scheduler"));
  });
  it("matches the full scan for every name, reading the workspace file list once", async () => {
    const differ: string[] = [];
    for (const [name, want] of full) if (JSON.stringify(key(await lookupName(name))) !== JSON.stringify(want)) differ.push(name);
    expect(differ).toEqual([]);
    expect(W.finds - finds).toBe(2); // the index's scan and the test's own
  });
  it("has every entry once in allNames", async () => {
    await nameIndexReady();
    const all = await allNames();
    expect(all.reduce((n, l) => n + l.length, 0)).toBe([...full.values()].reduce((n, l) => n + l.length, 0));
  });
  it("follows created, changed, saved and deleted files without a rescan", async () => {
    fs.writeFileSync(probe, "def probe_one():\n    pass\n");
    W.fire.create.fire([probe]);
    expect(await lookupName("probe_one")).toHaveLength(1);
    fs.writeFileSync(probe, "def probe_two():\n    pass\n");
    W.fire.change.fire(probe);
    expect(await lookupName("probe_one")).toHaveLength(0);
    expect(await lookupName("probe_two")).toHaveLength(1);
    W.open.set(probe, "def probe_three():\n    pass\n");
    W.fire.save.fire(probe);
    expect(await lookupName("probe_three")).toHaveLength(1);
    W.open.clear();
    fs.rmSync(probe);
    W.fire.delete.fire([probe]);
    expect(await lookupName("probe_two")).toHaveLength(0);
    expect(await lookupName("probe_three")).toHaveLength(0);
    expect(W.finds - finds).toBe(2);
  });
  it("lets timers run while building in the background", async () => {
    resetIndex();
    let ticks = 0;
    const t = setInterval(() => ticks++, 1);
    startNameIndex();
    await nameIndexReady();
    clearInterval(t);
    expect(ticks).toBeGreaterThan(3);
  });
});
