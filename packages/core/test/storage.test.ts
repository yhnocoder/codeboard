import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { emptyBoard } from "../src";
import { Storage, type DirEnt, type Fs } from "../src/storage";

/** In-memory Fs: files and directories keyed by "/"-joined paths; every write bumps a clock used as mtime */
class MemFs implements Fs {
  files = new Map<string, { data: string | Uint8Array; mtime: number; birth: number }>();
  dirs = new Set<string>(["/"]);
  reads = 0;
  clock = 1;
  join = (...p: string[]) => p.join("/").replace(/\/+/g, "/").split("/").reduce<string[]>((a, s) => (s === ".." ? a.slice(0, -1) : s === "." ? a : [...a, s]), []).join("/") || "/";
  private parent = (p: string) => p.slice(0, p.lastIndexOf("/")) || "/";
  private need(p: string) { if (!this.dirs.has(p)) throw new Error(`ENOENT ${p}`); }
  async readdir(dir: string): Promise<DirEnt[]> {
    this.need(dir);
    const out = new Map<string, DirEnt>();
    for (const f of this.files.keys()) if (this.parent(f) === dir) out.set(f, { name: f.slice(dir.length + 1), isFile: true, isDir: false });
    for (const d of this.dirs) if (d !== dir && this.parent(d) === dir) out.set(d, { name: d.slice(dir.length + 1), isFile: false, isDir: true });
    return [...out.values()];
  }
  async stat(p: string) {
    const f = this.files.get(p);
    if (!f) throw new Error(`ENOENT ${p}`);
    return { mtimeMs: f.mtime, birthtimeMs: f.birth, ctimeMs: f.birth };
  }
  async readFile(p: string) {
    const f = this.files.get(p);
    if (!f) throw new Error(`ENOENT ${p}`);
    this.reads++;
    return typeof f.data === "string" ? f.data : Buffer.from(f.data).toString("utf8");
  }
  async writeFile(p: string, data: string | Uint8Array) {
    this.need(this.parent(p));
    const t = ++this.clock;
    this.files.set(p, { data, mtime: t, birth: this.files.get(p)?.birth ?? t });
  }
  async rename(a: string, b: string) {
    const f = this.files.get(a);
    if (f) { this.need(this.parent(b)); this.files.delete(a); this.files.set(b, f); return; }
    this.need(a);
    for (const d of [...this.dirs]) if (d === a || d.startsWith(a + "/")) { this.dirs.delete(d); this.dirs.add(b + d.slice(a.length)); }
    for (const [k, v] of [...this.files]) if (k.startsWith(a + "/")) { this.files.delete(k); this.files.set(b + k.slice(a.length), v); }
  }
  async rm(p: string) {
    this.files.delete(p);
    for (const d of [...this.dirs]) if (d === p || d.startsWith(p + "/")) this.dirs.delete(d);
    for (const k of [...this.files.keys()]) if (k.startsWith(p + "/")) this.files.delete(k);
  }
  async mkdir(p: string) { for (let d = p; d !== "/" && !this.dirs.has(d); d = this.parent(d)) this.dirs.add(d); }
  fromBase64 = (s: string) => new Uint8Array(Buffer.from(s, "base64"));
  sha1 = (d: Uint8Array) => createHash("sha1").update(d).digest("hex");
  put(p: string, json: unknown) { void this.mkdir(this.parent(p)); const t = ++this.clock; this.files.set(p, { data: typeof json === "string" ? json : JSON.stringify(json), mtime: t, birth: t }); }
}

const ROOT = "/data/boards";
function setup() {
  const fs = new MemFs();
  const logs: string[] = [];
  const store = new Storage(fs, { dir: () => ROOT, log: (_l, t) => logs.push(t) });
  return { fs, store, logs };
}

describe("core storage", () => {
  it("creates, lists, loads and saves boards atomically", async () => {
    const { fs, store } = setup();
    let changed = 0, saved = 0;
    store.onDidChange(() => changed++);
    store.onDidSave(() => saved++);
    const b = await store.create("First");
    expect(fs.files.has(`${ROOT}/${b.id}.json`)).toBe(true);
    expect([...fs.files.keys()].some((k) => k.endsWith(".tmp"))).toBe(false);
    expect(await store.list()).toEqual([{ id: b.id, name: "First", group: undefined, cards: 0, stale: undefined }]);
    const l = (await store.load(b.id))!;
    l.name = "Renamed";
    await store.save(l);
    expect((await store.load(b.id))!.name).toBe("Renamed");
    expect(JSON.parse(await fs.readFile(`${ROOT}/${b.id}.json`)).name).toBe("Renamed");
    expect([changed, saved]).toEqual([2, 2]);
    // Same outline: saved fires, changed does not
    l.cam = { x: 1, y: 2, z: 1 };
    await store.save(l);
    expect([changed, saved]).toEqual([2, 3]);
  });

  it("caches parsed boards by mtime", async () => {
    const { fs, store } = setup();
    fs.put(`${ROOT}/a.json`, emptyBoard("a", "A"));
    await store.list();
    const n = fs.reads;
    await store.list();
    expect(fs.reads).toBe(n);
    fs.put(`${ROOT}/a.json`, { ...emptyBoard("a", "A2") });
    expect((await store.list())[0].name).toBe("A2");
    expect(fs.reads).toBe(n + 1);
  });

  it("groups are one level of subfolders; empty groups are listed; reserved names are not groups", async () => {
    const { fs, store } = setup();
    fs.put(`${ROOT}/g1/a.json`, emptyBoard("a", "A"));
    fs.put(`${ROOT}/g1/deeper/x.json`, emptyBoard("x", "X")); // only one level
    fs.put(`${ROOT}/assets/i.json`, emptyBoard("i", "I"));
    fs.put(`${ROOT}/.trash/t.json`, emptyBoard("t", "T"));
    fs.put(`${ROOT}/github/gh.json`, emptyBoard("gh", "GH"));
    await fs.mkdir(`${ROOT}/empty`);
    expect((await store.list()).map((m) => [m.id, m.group])).toEqual([["a", "g1"]]);
    expect(await store.groups()).toEqual(["empty", "g1"]);
    await store.newGroup("a/b");
    expect(await store.groups()).toContain("a-b");
    for (const bad of ["..", ".", ".trash", "assets", "github", "  "]) await store.newGroup(bad);
    expect(await store.groups()).toEqual(["a-b", "empty", "g1"]);
  });

  it("move, renameGroup and removeGroup keep boards and stay inside the storage folder", async () => {
    const { fs, store } = setup();
    const b = await store.create("B");
    await store.newGroup("G");
    await store.move(b.id, "G");
    expect(store.groupOf(b.id)).toBe("G");
    expect(fs.files.has(`${ROOT}/G/${b.id}.json`) && !fs.files.has(`${ROOT}/${b.id}.json`)).toBe(true);
    await store.move(b.id, "..");
    expect(store.groupOf(b.id)).toBe("G");
    await store.renameGroup("G", "H");
    expect((await store.list())[0].group).toBe("H");
    await store.renameGroup("..", "X");
    await store.renameGroup("H", "..");
    expect(await store.groups()).toEqual(["H"]);
    fs.put("/data/keep.json", emptyBoard("keep", "Keep"));
    await store.removeGroup("..");
    await store.removeGroup("../..");
    expect(fs.files.has("/data/keep.json") && fs.dirs.has(ROOT)).toBe(true);
    await store.removeGroup("H");
    expect((await store.list()).map((m) => [m.id, m.group])).toEqual([[b.id, undefined]]);
    expect(fs.dirs.has(`${ROOT}/H`)).toBe(false);
    await store.move(b.id, "New");
    expect(store.groupOf(b.id)).toBe("New");
    await store.move(b.id, undefined);
    expect(store.groupOf(b.id)).toBe(undefined);
  });

  it("deleting moves the file to .trash", async () => {
    const { fs, store } = setup();
    const b = await store.create("B");
    await store.remove(b.id);
    expect(await store.list()).toEqual([]);
    const trashed = [...fs.files.keys()].filter((k) => k.startsWith(`${ROOT}/.trash/${b.id}.`) && k.endsWith(".json"));
    expect(trashed.length).toBe(1);
  });

  it("gives a Finder copy (same id, other file name) a new id; unsafe ids fall back to the file name", async () => {
    const { fs, store } = setup();
    fs.put(`${ROOT}/b1.json`, emptyBoard("b1", "One"));
    fs.put(`${ROOT}/b1 copy.json`, emptyBoard("b1", "One copy"));
    fs.put(`${ROOT}/x.json`, emptyBoard("dup", "X"));
    fs.put(`${ROOT}/y.json`, emptyBoard("dup", "Y"));
    fs.put(`${ROOT}/safe-name.json`, { ...emptyBoard("../evil", "Evil") });
    const metas = await store.list();
    const ids = metas.map((m) => m.id);
    expect(new Set(ids).size).toBe(5);
    expect(metas.find((m) => m.name === "One")!.id).toBe("b1");
    expect(metas.find((m) => m.name === "One copy")!.id).not.toBe("b1");
    expect(metas.find((m) => m.name === "Evil")!.id).toBe("safe-name");
    expect(ids.filter((i) => i === "dup").length).toBe(1);
    // Saving the copy writes its own file instead of overwriting b1.json
    const copy = (await store.load(metas.find((m) => m.name === "One copy")!.id))!;
    await store.save(copy);
    expect(JSON.parse(await fs.readFile(`${ROOT}/b1.json`)).name).toBe("One");
    await expect(store.save({ ...copy, id: "../x" })).rejects.toThrow(/Bad board id/);
  });

  it("skips bad files and logs each once", async () => {
    const { fs, store, logs } = setup();
    fs.put(`${ROOT}/bad.json`, "{not json");
    fs.put(`${ROOT}/newer.json`, { ...emptyBoard("newer", "N"), version: 99 });
    fs.put(`${ROOT}/ok.json`, emptyBoard("ok", "OK"));
    expect((await store.list()).map((m) => m.id)).toEqual(["ok"]);
    await store.list();
    expect(logs.length).toBe(2);
    expect(logs.some((l) => l.includes("bad.json")) && logs.some((l) => l.includes("newer"))).toBe(true);
  });

  it("migrates old boards and fills missing arrays", async () => {
    const { fs, store } = setup();
    const raw: Record<string, unknown> = { ...emptyBoard("m", "M") };
    delete raw.sidenotes; delete raw.sections;
    fs.put(`${ROOT}/m.json`, raw);
    const b = (await store.load("m"))!;
    expect(b.sidenotes).toEqual([]);
    expect(b.sections).toEqual([]);
  });

  it("stores assets by content hash", async () => {
    const { fs, store } = setup();
    const png = `data:image/png;base64,${Buffer.from("hello").toString("base64")}`;
    const a = await store.saveAsset("pic.PNG", png);
    const b = await store.saveAsset("other.png", png);
    expect(a).toBe(`${createHash("sha1").update("hello").digest("hex").slice(0, 16)}.png`);
    expect(b).toBe(a);
    expect(await store.saveAsset("", `data:image/jpeg;base64,AAAA`)).toMatch(/^[0-9a-f]{16}\.jpg$/);
    expect(await store.saveAsset("", `data:image/svg+xml;base64,AAAA`)).toMatch(/\.svg$/);
    expect([...fs.files.keys()].filter((k) => k.startsWith(`${ROOT}/assets/`)).length).toBe(3);
    await expect(store.saveAsset("x", "nope")).rejects.toThrow("Not an image");
  });

  it("duplicates into the same group and renames", async () => {
    const { store } = setup();
    const b = await store.create("B", "G");
    const d = (await store.duplicate(b.id))!;
    expect(d.name).toBe("B copy");
    expect(store.groupOf(d.id)).toBe("G");
    await store.rename(b.id, "C");
    expect((await store.list()).map((m) => m.name).sort()).toEqual(["B copy", "C"]);
  });
});

describe("card library (shared cards)", () => {
  const note = (id: string, md = id) => ({ id, kind: "note" as const, md, bg: true });
  /** Two boards with the same card "s" (one shared through the library) and a board-only card each */
  async function two() {
    const t = setup();
    const a = emptyBoard("A", "A");
    a.cards.push(note("s"), note("la")); a.place.s = { x: 0, y: 0, w: 100 }; a.place.la = { x: 200, y: 0, w: 100 };
    a.sidenotes.push({ id: "n1", kind: "text", md: "travels", at: { card: "s" } }, { id: "n2", kind: "text", md: "mine", at: { card: "s" }, boardOnly: true });
    await t.store.save(a);
    expect(await t.store.share("A", ["s"])).toEqual({});
    // B gets the shared card the way a duplicate of A would: same refs
    const d = (await t.store.duplicate("A"))!;
    await t.store.patch(d.id, { sidenotes: { del: ["n2"] } }); // the copy drops A's board-only sidenote
    const shared: { from: string; ids: string[]; items: string[] }[] = [];
    t.store.onDidShare((e) => shared.push({ from: e.from, ids: e.cards.map((c) => c.card.id), items: e.cards.flatMap((c) => c.items) }));
    return { ...t, a, B: d.id, shared };
  }
  const card = (fs: MemFs, id: string) => JSON.parse(fs.files.get(`${ROOT}/cards/${id}.json`)!.data as string);
  const file = (fs: MemFs, id: string) => JSON.parse(fs.files.get(`${ROOT}/${id}.json`)!.data as string);

  it("stores a shared card once: refs in board files, content and travelling sidenotes in cards/<id>.json", async () => {
    const { fs, store, B } = await two();
    expect(file(fs, "A").cards).toEqual([{ id: "s", kind: "shared" }, note("la")]);
    expect(file(fs, "A").sidenotes.map((n: any) => n.id)).toEqual(["n2"]);
    const c = card(fs, "s");
    expect(c).toMatchObject({ version: 6, card: note("s"), rev: { s: 1, n1: 1 } });
    expect(c.sidenotes.map((n: any) => n.id)).toEqual(["n1"]);
    // Loading inflates
    const a = (await store.load("A"))!;
    expect(a.cards.map((x) => x.id)).toEqual(["s", "la"]);
    expect(a.sidenotes.map((n) => n.id).sort()).toEqual(["n1", "n2"]);
    expect(await store.boardsWith("s")).toEqual(["A", B]);
    expect([...store.refsOf(B)]).toEqual(["s"]);
    // Re-reading from disk (fresh storage) gives the same boards
    const again = new Storage(fs, { dir: () => ROOT });
    const sorted = (b: any) => ({ ...b, sidenotes: [...b.sidenotes].sort((x: any, y: any) => x.id.localeCompare(y.id)) });
    expect(sorted(await again.load("A"))).toEqual(sorted(a));
  });

  it("a patch to a shared card writes the card file, bumps the item's rev, updates the other board and reports it once", async () => {
    const { fs, store, B, shared } = await two();
    const before = file(fs, B);
    const back = await store.patch("A", { cards: { set: [note("s", "edited")] }, sidenotes: { set: [{ id: "n3", kind: "text", md: "new", at: { card: "s" } }] } });
    expect(back).toEqual([]);
    expect(card(fs, "s")).toMatchObject({ card: { md: "edited" }, rev: { s: 2, n1: 1, n3: 1 } });
    expect(file(fs, B)).toEqual(before); // only the card file changes for the other board
    expect(shared).toEqual([{ from: "A", ids: ["s"], items: ["s", "n3"] }]);
    const b = store.peek(B)!;
    expect((b.cards[0] as any).md).toBe("edited");
    expect(b.sidenotes.map((n) => n.id)).toContain("n3");
    expect(b.sidenotes.map((n) => n.id)).not.toContain("n2"); // A's board-only sidenote stays on A
    // A no-op write (e.g. the same content again) does not bump or broadcast
    await store.patch("A", { cards: { set: [note("s", "edited")] } });
    expect(card(fs, "s").rev.s).toBe(2);
    expect(shared.length).toBe(1);
    // Local cards never touch the library
    await store.patch("A", { cards: { set: [note("la", "x")] } });
    expect(shared.length).toBe(1);
  });

  it("removing a shared card from one board keeps it in the library and on the other board", async () => {
    const { fs, store, B } = await two();
    await store.patch("A", { cards: { del: ["s"] }, place: { del: ["s"] }, sidenotes: { del: ["n1", "n2"] } });
    expect(file(fs, "A").cards).toEqual([note("la")]);
    expect(card(fs, "s").sidenotes.map((n: any) => n.id)).toEqual(["n1"]);
    expect(await store.boardsWith("s")).toEqual([B]);
    expect((await store.load(B))!.sidenotes.map((n) => n.id)).toEqual(["n1"]);
  });

  it("deleting or board-only-ing a travelling sidenote removes it from the library", async () => {
    const { fs, store, B, shared } = await two();
    await store.patch(B, { sidenotes: { set: [{ id: "n1", kind: "text", md: "travels", at: { card: "s" }, boardOnly: true }] } });
    expect(card(fs, "s").sidenotes).toEqual([]);
    expect(card(fs, "s").rev.n1).toBeUndefined();
    expect(shared.at(-1)).toEqual({ from: B, ids: ["s"], items: ["n1"] });
    expect(store.peek("A")!.sidenotes.map((n) => n.id)).toEqual(["n2"]); // gone from A, stays on B as its own
    expect(file(fs, B).sidenotes.map((n: any) => n.id)).toEqual(["n1"]);
  });

  it("undo skips shared items another board changed since this board wrote them", async () => {
    const { fs, store, B } = await two();
    await store.patch("A", { cards: { set: [note("s", "by A")] } });
    await store.patch(B, { cards: { set: [note("s", "by B")] } });
    // A undoes its edit: B wrote the card after A, so A's undo is skipped and A gets B's version back
    const back = await store.patch("A", { cards: { set: [note("s", "s"), note("la", "undone too")] } }, { undo: true });
    expect(back).toEqual([{ card: note("s", "by B"), sidenotes: [expect.objectContaining({ id: "n1" })], items: ["s"] }]);
    expect(card(fs, "s").card.md).toBe("by B");
    expect((store.peek("A")!.cards[1] as any).md).toBe("undone too"); // local items in the same patch still apply
    // B undoes its own last write: allowed
    expect(await store.patch(B, { cards: { set: [note("s", "by A")] } }, { undo: true })).toEqual([]);
    expect(card(fs, "s").card.md).toBe("by A");
    // Without undo it is last writer wins
    expect(await store.patch("A", { cards: { set: [note("s", "A again")] } })).toEqual([]);
    expect(card(fs, "s").card.md).toBe("A again");
  });

  it("undo of a shared sidenote follows the same rule per item", async () => {
    const { fs, store, B } = await two();
    await store.patch(B, { sidenotes: { set: [{ id: "n1", kind: "text", md: "B's", at: { card: "s" } }] } });
    const back = await store.patch("A", { sidenotes: { del: ["n1"] } }, { undo: true });
    expect(back.map((x) => x.items)).toEqual([["n1"]]);
    expect(card(fs, "s").sidenotes.map((n: any) => n.md)).toEqual(["B's"]);
  });

  it("unshare leaves this board an own copy; sharing again with a taken id renames the card", async () => {
    const { fs, store, B } = await two();
    expect(await store.unshare(B, "s")).toBe(true);
    expect(file(fs, B).cards[0]).toEqual(note("s"));
    expect(file(fs, B).sidenotes.map((n: any) => n.id)).toEqual(["n1"]);
    expect(await store.boardsWith("s")).toEqual(["A"]);
    await store.patch(B, { cards: { set: [note("s", "B only")] } });
    expect(card(fs, "s").card.md).toBe("s");
    const r = await store.share(B, ["s"]);
    const n = r.s;
    expect(n).toMatch(/^c/);
    expect(card(fs, n).card.md).toBe("B only");
    expect(store.peek(B)!.place[n]).toBeTruthy();
    expect(await store.boardsWith("s")).toEqual(["A"]);
  });

  it("picks up a shared card edited outside the app", async () => {
    const { fs, store, B } = await two();
    const c = card(fs, "s");
    c.card.md = "outside";
    fs.put(`${ROOT}/cards/s.json`, c);
    expect(((await store.load(B))!.cards[0] as any).md).toBe("outside");
    expect(((await store.load("A"))!.cards[0] as any).md).toBe("outside");
  });

  it("a full patch (after a failed save) replaces the board", async () => {
    const { store } = await two();
    await store.patch("A", { full: true, head: { name: "Full" } as any, cards: { set: [note("s"), note("x")] }, place: { set: { s: { x: 1, y: 1, w: 1 }, x: { x: 1, y: 1, w: 1 } } } });
    const a = (await store.load("A"))!;
    expect(a.name).toBe("Full");
    expect(a.cards.map((c) => c.id)).toEqual(["s", "x"]);
    expect(a.sidenotes).toEqual([]);
    expect([...store.refsOf("A")]).toEqual(["s"]);
  });
});
