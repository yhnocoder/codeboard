import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { danglingRefs, emptyBoard, type Board } from "../src";

const headOf = (b: Board) => { const { version: _v, id: _i, cam: _c, cards: _a, place: _p, links: _l, sections: _s, sidenotes: _n, stickers: _k, ...h } = b; return h; };
import { Storage, pasteClip, type DirEnt, type Fs } from "../src/storage";

/** In-memory Fs: files and directories keyed by "/"-joined paths; every write bumps a clock used as mtime */
class MemFs implements Fs {
  files = new Map<string, { data: string | Uint8Array; mtime: number; birth: number }>();
  /** Watchers (StorageOpts.watch) told about every .json created, changed or deleted under their folder, a tick later like a file watcher */
  private watchers = new Set<{ base: string; fn: (abs: string) => void }>();
  watch = (base: string, _glob: string, fn: (abs: string) => void) => {
    const w = { base, fn };
    this.watchers.add(w);
    return { dispose: () => void this.watchers.delete(w) };
  };
  private touched(p: string) {
    if (p.endsWith(".json")) for (const w of this.watchers) if (p.startsWith(w.base + "/")) setTimeout(() => w.fn(p), 0);
  }
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
  /** While set, writes wait for it (to line up a slow write against other calls) */
  hold: Promise<void> | null = null;
  async writeFile(p: string, data: string | Uint8Array) {
    if (this.hold) await this.hold;
    this.need(this.parent(p));
    const t = ++this.clock;
    this.files.set(p, { data, mtime: t, birth: this.files.get(p)?.birth ?? t });
    this.touched(p);
  }
  async rename(a: string, b: string) {
    const f = this.files.get(a);
    if (f) { this.need(this.parent(b)); this.files.delete(a); this.files.set(b, f); this.touched(a); this.touched(b); return; }
    this.need(a);
    for (const d of [...this.dirs]) if (d === a || d.startsWith(a + "/")) { this.dirs.delete(d); this.dirs.add(b + d.slice(a.length)); }
    for (const [k, v] of [...this.files]) if (k.startsWith(a + "/")) { this.files.delete(k); this.files.set(b + k.slice(a.length), v); }
  }
  async rm(p: string) { this.files.delete(p); this.touched(p); }
  async rmdir(p: string) {
    this.need(p);
    if ((await this.readdir(p)).length) throw new Error(`ENOTEMPTY ${p}`);
    this.dirs.delete(p);
  }
  async mkdir(p: string) { for (let d = p; d !== "/" && !this.dirs.has(d); d = this.parent(d)) this.dirs.add(d); }
  fromBase64 = (s: string) => new Uint8Array(Buffer.from(s, "base64"));
  sha1 = (d: Uint8Array) => createHash("sha1").update(d).digest("hex");
  put(p: string, json: unknown) { void this.mkdir(this.parent(p)); const t = ++this.clock; this.files.set(p, { data: typeof json === "string" ? json : JSON.stringify(json), mtime: t, birth: t }); }
}

const ROOT = "/data/boards";
/** A patch written to disk right away (the storage otherwise writes it after a short delay) */
async function patchNow(store: Storage, ...a: Parameters<Storage["patch"]>) { const r = await store.patch(...a); await store.flush(); return r; }
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

  it("deleting a group moves its boards out and keeps the folder with any file that isn't a readable board", async () => {
    const { fs, store } = setup();
    const b = await store.create("B");
    await store.newGroup("G");
    await store.move(b.id, "G");
    fs.put(`${ROOT}/G/handedit.json`, "{ \"cards\": [ oops");
    fs.put(`${ROOT}/G/notes.txt`, "my notes");
    expect((await store.removeGroup("G")).sort()).toEqual(["handedit.json", "notes.txt"]);
    expect(store.groupOf(b.id)).toBe(undefined);
    expect(fs.files.has(`${ROOT}/${b.id}.json`)).toBe(true);
    expect(fs.files.get(`${ROOT}/G/handedit.json`)?.data).toBe("{ \"cards\": [ oops");
    expect(fs.files.get(`${ROOT}/G/notes.txt`)?.data).toBe("my notes");
    expect(await store.groups()).toEqual(["G"]);
    // once only boards were in it, the folder goes
    await fs.rm(`${ROOT}/G/handedit.json`); await fs.rm(`${ROOT}/G/notes.txt`);
    expect(await store.removeGroup("G")).toEqual([]);
    expect(fs.dirs.has(`${ROOT}/G`)).toBe(false);
    expect(await store.groups()).toEqual([]);
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
    await patchNow(t.store, d.id, { sidenotes: { del: ["n2"] } }); // the copy drops A's board-only sidenote
    const shared: { from?: string; ids: string[]; items: string[] }[] = [];
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
    expect(c).toMatchObject({ version: 6, card: note("s") });
    expect(c.rev).toBeUndefined();
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

  it("a patch to a shared card writes the card file, updates the other board and reports it once", async () => {
    const { fs, store, B, shared } = await two();
    const before = file(fs, B);
    const back = await patchNow(store, "A", { cards: { set: [note("s", "edited")] }, sidenotes: { set: [{ id: "n3", kind: "text", md: "new", at: { card: "s" } }] } });
    expect(back).toEqual([]);
    expect(card(fs, "s")).toMatchObject({ card: { md: "edited" } });
    expect(card(fs, "s").sidenotes.map((n: any) => n.id).sort()).toEqual(["n1", "n3"]);
    expect(file(fs, B)).toEqual(before); // only the card file changes for the other board
    expect(shared).toEqual([{ from: "A", ids: ["s"], items: ["s", "n3"] }]);
    const b = store.peek(B)!;
    expect((b.cards[0] as any).md).toBe("edited");
    expect(b.sidenotes.map((n) => n.id)).toContain("n3");
    expect(b.sidenotes.map((n) => n.id)).not.toContain("n2"); // A's board-only sidenote stays on A
    // A no-op write (e.g. the same content again) does not rewrite or broadcast
    const writes = fs.files.get(`${ROOT}/cards/s.json`)!.mtime;
    await patchNow(store, "A", { cards: { set: [note("s", "edited")] } });
    expect(fs.files.get(`${ROOT}/cards/s.json`)!.mtime).toBe(writes);
    expect(shared.length).toBe(1);
    // Local cards never touch the library
    await patchNow(store, "A", { cards: { set: [note("la", "x")] } });
    expect(shared.length).toBe(1);
  });

  it("removing a shared card from one board keeps it in the library and on the other board", async () => {
    const { fs, store, B } = await two();
    await patchNow(store, "A", { cards: { del: ["s"] }, place: { del: ["s"] }, sidenotes: { del: ["n1", "n2"] } });
    expect(file(fs, "A").cards).toEqual([note("la")]);
    expect(card(fs, "s").sidenotes.map((n: any) => n.id)).toEqual(["n1"]);
    expect(await store.boardsWith("s")).toEqual([B]);
    expect((await store.load(B))!.sidenotes.map((n) => n.id)).toEqual(["n1"]);
  });

  it("deleting or board-only-ing a travelling sidenote removes it from the library", async () => {
    const { fs, store, B, shared } = await two();
    await patchNow(store, B, { sidenotes: { set: [{ id: "n1", kind: "text", md: "travels", at: { card: "s" }, boardOnly: true }] } });
    expect(card(fs, "s").sidenotes).toEqual([]);
    expect(shared.at(-1)).toEqual({ from: B, ids: ["s"], items: ["n1"] });
    expect(store.peek("A")!.sidenotes.map((n) => n.id)).toEqual(["n2"]); // gone from A, stays on B as its own
    expect(file(fs, B).sidenotes.map((n: any) => n.id)).toEqual(["n1"]);
  });

  it("merges a shared card item by item when another window changed the card file", async () => {
    const { fs, store, shared } = await two();
    const backs: unknown[] = [];
    store.onDidShare((e) => backs.push(e.back));
    // Another VS Code window on the same storage folder adds a sidenote and edits n1
    const disk = card(fs, "s");
    disk.sidenotes = [{ ...disk.sidenotes[0], md: "edited elsewhere" }, { id: "nx", kind: "text", md: "from the other window", at: { card: "s" } }];
    fs.put(`${ROOT}/cards/s.json`, disk);
    // This window edits only the card: the other window's sidenotes survive
    await patchNow(store, "A", { cards: { set: [note("s", "edited here")] } });
    const c = card(fs, "s");
    expect(c.card.md).toBe("edited here");
    expect(c.sidenotes.map((n: any) => [n.id, n.md]).sort()).toEqual([["n1", "edited elsewhere"], ["nx", "from the other window"]]);
    // The writing board takes the merged items back; its cache already has them
    expect(backs.at(-1)).toEqual([expect.objectContaining({ items: ["n1", "nx"] })]);
    expect(store.peek("A")!.sidenotes.map((n) => n.id).sort()).toEqual(["n1", "n2", "nx"]);
    expect(shared.at(-1)!.items.sort()).toEqual(["n1", "nx", "s"]);
    // Deleting a sidenote this board saw still deletes it; one it never saw stays
    await patchNow(store, "A", { sidenotes: { del: ["n1"] } });
    expect(card(fs, "s").sidenotes.map((n: any) => n.id)).toEqual(["nx"]);
  });

  it("undo skips shared items another board changed since this board wrote them", async () => {
    const { fs, store, B } = await two();
    await patchNow(store, "A", { cards: { set: [note("s", "by A")] } });
    await patchNow(store, B, { cards: { set: [note("s", "by B")] } });
    // A undoes its edit: B wrote the card after A, so A's undo is skipped and A gets B's version back
    const back = await patchNow(store, "A", { cards: { set: [note("s", "s"), note("la", "undone too")] } }, { undo: true });
    expect(back).toEqual([{ card: note("s", "by B"), sidenotes: [expect.objectContaining({ id: "n1" })], items: ["s"] }]);
    expect(card(fs, "s").card.md).toBe("by B");
    expect((store.peek("A")!.cards[1] as any).md).toBe("undone too"); // local items in the same patch still apply
    // B undoes its own last write: allowed
    expect(await patchNow(store, B, { cards: { set: [note("s", "by A")] } }, { undo: true })).toEqual([]);
    expect(card(fs, "s").card.md).toBe("by A");
    // Without undo it is last writer wins
    expect(await patchNow(store, "A", { cards: { set: [note("s", "A again")] } })).toEqual([]);
    expect(card(fs, "s").card.md).toBe("A again");
  });

  it("undo of a shared sidenote follows the same rule per item", async () => {
    const { fs, store, B } = await two();
    await patchNow(store, B, { sidenotes: { set: [{ id: "n1", kind: "text", md: "B's", at: { card: "s" } }] } });
    const back = await patchNow(store, "A", { sidenotes: { del: ["n1"] } }, { undo: true });
    expect(back.map((x) => x.items)).toEqual([["n1"]]);
    expect(card(fs, "s").sidenotes.map((n: any) => n.md)).toEqual(["B's"]);
  });

  it("unshare leaves this board an own copy under a new id; the library and the other board keep the shared card", async () => {
    const { fs, store, B } = await two();
    const n = (await store.unshare(B, "s"))!;
    expect(n).toMatch(/^c/);
    expect(file(fs, B).cards[0]).toEqual({ ...note("s"), id: n });
    expect(file(fs, B).sidenotes.map((x: any) => [x.id, x.at.card])).toEqual([["n1", n]]);
    expect(await store.boardsWith("s")).toEqual(["A"]);
    await patchNow(store, B, { cards: { set: [note(n, "B only")] } });
    expect(card(fs, "s").card.md).toBe("s");
    expect(await store.share(B, [n])).toEqual({});
    expect(card(fs, n).card.md).toBe("B only");
    expect(await store.unshare(B, "la")).toBe(null);
  });

  it("an offered shared card pasted onto a board, or a shared card brought back by undoing Remove from Board, is linked again", async () => {
    const { fs, store, B } = await two();
    const C = (await store.create("C")).id;
    // Paste as linked card: pasteClip offers it, then the board sends the card with the same id
    await store.offer(C, ["s"]);
    await patchNow(store, C, { cards: { set: [note("s", "s")] }, place: { set: { s: { x: 0, y: 0, w: 1 } } } });
    expect(file(fs, C).cards).toEqual([{ id: "s", kind: "shared" }]);
    expect(await store.boardsWith("s")).toEqual(["A", B, C]);
    // Remove from Board, then undo
    await patchNow(store, B, { cards: { del: ["s"] }, place: { del: ["s"] }, sidenotes: { del: ["n1"] } });
    expect(await store.boardsWith("s")).toEqual(["A", C]);
    await patchNow(store, B, { cards: { set: [note("s", "s")] }, place: { set: { s: { x: 0, y: 0, w: 1 } } } }, { undo: true });
    expect(await store.boardsWith("s")).toEqual(["A", B, C]);
    expect(file(fs, B).cards.at(-1)).toEqual({ id: "s", kind: "shared" });
  });

  it("Delete Everywhere removes the card, its links and sidenotes from every board and moves the library file to .trash", async () => {
    const { fs, store, B } = await two();
    await patchNow(store, B, { cards: { set: [note("x")] }, place: { set: { x: { x: 0, y: 0, w: 1 } } }, links: { set: [{ id: "l", from: { card: "x" }, to: { card: "s" } }] } });
    const gone: unknown[] = [];
    store.onDidRemoveShared((e) => gone.push(e));
    expect(await store.deleteEverywhere("s", "A")).toEqual(["A", B]);
    expect(file(fs, "A").cards).toEqual([note("la")]);
    expect(file(fs, "A").sidenotes).toEqual([]);
    expect(file(fs, B).cards).toEqual([note(file(fs, B).cards[0].id, "la"), note("x")]);
    expect(file(fs, B).links).toEqual([]);
    expect(fs.files.has(`${ROOT}/cards/s.json`)).toBe(false);
    expect([...fs.files.keys()].some((f) => f.startsWith(`${ROOT}/.trash/card-s.`))).toBe(true);
    expect(gone).toEqual([{ from: "A", card: "s", boards: ["A", B] }]);
    // Undoing on A brings back an own copy (the library no longer has it)
    await patchNow(store, "A", { cards: { set: [note("s")] }, place: { set: { s: { x: 0, y: 0, w: 1 } } } }, { undo: true });
    expect(file(fs, "A").cards[1]).toEqual(note("s"));
  });

  it("copyOut gives a card with its place and travelling sidenotes, and the links between the copied cards; cached() lists the boards with their refs", async () => {
    const { store, B } = await two();
    const out = store.copyOut("A", ["s", "missing"]);
    expect(out.cards.map((x) => [x.card.id, !!x.place, x.sidenotes!.map((n) => n.id)])).toEqual([["s", true, ["n1"]]]);
    expect(out.links).toEqual([]);
    await patchNow(store, "A", { links: { set: [{ id: "l", from: { card: "s" }, to: { card: "la" } }, { id: "self", from: { card: "la" }, to: { card: "la", line: 1 } }] } });
    expect(store.copyOut("A", ["s", "la"]).links.map((l) => l.id)).toEqual(["l", "self"]);
    expect(store.copyOut("A", ["s"]).links).toEqual([]);
    expect(store.cached().map((e) => [e.id, [...e.refs]])).toEqual([["A", ["s"]], [B, ["s"]]]);
  });

  it("a new version of a shared code card moves the other board's own line references and writes that board", async () => {
    const t = new MemFs();
    const store = new Storage(t, { dir: () => ROOT });
    const seg = (start: number, text: string[], commit: string) => ({ id: "g", src: { kind: "repo" as const, repo: "" }, path: "a.py", lang: "python", start, end: start + text.length - 1, text, version: { kind: "git" as const, commit } });
    const code = (sg: ReturnType<typeof seg>) => ({ id: "s", kind: "code" as const, segments: [sg] });
    const old = seg(10, ["def f():", "    x = 1", "    return x"], "a");
    const a = { ...emptyBoard("A", "A"), cards: [code(old), note("z")], place: { s: { x: 0, y: 0, w: 1 }, z: { x: 0, y: 0, w: 1 } } };
    await store.save(a);
    await store.share("A", ["s"]);
    const B = (await store.duplicate("A"))!.id;
    await patchNow(store, B, {
      links: { set: [{ id: "l", from: { card: "z" }, to: { card: "s", seg: "g", line: 12 } }] },
      sidenotes: { set: [{ id: "bo", kind: "text", md: "mine", at: { card: "s", seg: "g", lines: [11, 11] }, boardOnly: true }] },
    });
    // A updates: two lines added on top, line 11 edited
    const now = seg(10, ["# a", "# b", "def f():", "    x = 2", "    return x"], "b");
    await patchNow(store, "A", { cards: { set: [code(now)] } });
    const fb = file(t, B);
    expect(fb.links[0].to).toEqual({ card: "s", seg: "g", line: 14 });
    expect(fb.sidenotes[0]).toMatchObject({ id: "bo", at: { lines: [13, 13] }, review: "b" });
    expect(store.peek(B)!.links[0].to.line).toBe(14);
  });

  it("pasteClip: cards copied on one board paste onto another as linked cards (shared first), or as a copy; the same board and other text do not match", async () => {
    const { fs, store } = await two();
    const C = (await store.create("C")).id;
    const clip = { board: "A", cards: ["la"], text: "la" };
    expect(await pasteClip(store, clip, "A", { copy: false })).toBe(null);
    expect(await pasteClip(store, clip, C, { text: "something else", copy: false })).toBe(null);
    const copy = (await pasteClip(store, clip, C, { text: "la\n", copy: true }))!;
    expect([copy.from, copy.shared, copy.cards.map((x) => x.card.id)]).toEqual(["A", false, ["la"]]);
    expect(fs.files.has(`${ROOT}/cards/la.json`)).toBe(false);
    const linked = (await pasteClip(store, clip, C, { text: "la", copy: false }))!;
    expect(linked.shared).toBe(true);
    expect(card(fs, "la").card.md).toBe("la");
    expect([...store.refsOf("A")].sort()).toEqual(["la", "s"]);
  });

  it("only cards the board held or was offered come back as shared cards; other library ids stay plain cards", async () => {
    const { store } = await two();
    const C = (await store.create("C")).id;
    await patchNow(store, "A", { cards: { del: ["s"] }, place: { del: ["s"] }, sidenotes: { del: ["n1", "n2"] } });
    expect(store.refsOf("A").has("s")).toBe(false);
    await patchNow(store, "A", { cards: { set: [note("s")] }, place: { set: { s: { x: 0, y: 0, w: 100 } } } }, { undo: true });
    expect(store.refsOf("A").has("s")).toBe(true); // Remove from Board 撤销回来
    await patchNow(store, C, { cards: { set: [note("s")] }, place: { set: { s: { x: 0, y: 0, w: 100 } } } });
    expect(store.refsOf(C).has("s")).toBe(false); // 没贴过来，同 id 也不认
    const linked = (await pasteClip(store, { board: "A", cards: ["la"], text: "la" }, C, { copy: false }))!;
    await patchNow(store, C, { cards: { set: linked.cards.map((x) => x.card) }, place: { set: { la: linked.cards[0].place! } } });
    expect(store.refsOf(C).has("la")).toBe(true);
  });

  it("editing a card on a duplicated board never overwrites the original card after the original is shared", async () => {
    const { fs, store } = setup();
    const a = emptyBoard("A", "A");
    a.cards.push(note("k")); a.place.k = { x: 0, y: 0, w: 100 };
    await store.save(a);
    const d = (await store.duplicate("A"))!;
    const dk = d.cards[0].id;
    expect(dk).not.toBe("k"); // the duplicate's own card is a different card
    await patchNow(store, "A", { sidenotes: { set: [{ id: "na", kind: "text", md: "on the original", at: { card: "k" } }] } });
    const C = (await store.create("C")).id;
    const linked = (await pasteClip(store, { board: "A", cards: ["k"], text: "k" }, C, { copy: false }))!;
    await patchNow(store, C, { cards: { set: linked.cards.map((x) => x.card) }, place: { set: { k: linked.cards[0].place! } } });
    // Edit the card on the duplicate, sending it under the old id too (a webview that still had it)
    await patchNow(store, d.id, { cards: { set: [note(dk, "edited on the copy")] } });
    await patchNow(store, d.id, { cards: { set: [note("k", "stray id")] } });
    expect(store.refsOf(d.id).has("k")).toBe(false);
    expect(card(fs, "k").card.md).toBe("k");
    expect(card(fs, "k").sidenotes.map((n: any) => n.id)).toEqual(["na"]);
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
    await patchNow(store, "A", { full: true, head: { name: "Full" } as any, cards: { set: [note("s"), note("x")] }, place: { set: { s: { x: 1, y: 1, w: 1 }, x: { x: 1, y: 1, w: 1 } } } });
    const a = (await store.load("A"))!;
    expect(a.name).toBe("Full");
    expect(a.cards.map((c) => c.id)).toEqual(["s", "x"]);
    expect(a.sidenotes).toEqual([]);
    expect([...store.refsOf("A")]).toEqual(["s"]);
  });
});

describe("two windows on one storage folder", () => {
  const note = (id: string, md = id) => ({ id, kind: "note" as const, md, bg: true });
  it("a board edit in one window keeps the cards another window added to the same board", async () => {
    const fs = new MemFs();
    const w1 = new Storage(fs, { dir: () => ROOT }), w2 = new Storage(fs, { dir: () => ROOT });
    const a = emptyBoard("A", "A");
    a.cards.push(note("x")); a.place.x = { x: 0, y: 0, w: 100 };
    await w1.save(a);
    await w2.load("A");
    const merges: unknown[] = [];
    w1.onDidMerge((e) => merges.push(e.patch));
    // Window 2 adds a card and renames the board; window 1 then edits x without having seen either
    await patchNow(w2, "A", { cards: { set: [note("y")] }, place: { set: { y: { x: 200, y: 0, w: 100 } } }, head: { ...headOf(a), name: "Renamed elsewhere" } });
    await patchNow(w1, "A", { cards: { set: [note("x", "edited here")] } });
    const f = JSON.parse(fs.files.get(`${ROOT}/A.json`)!.data as string);
    expect(f.cards).toEqual([note("x", "edited here"), note("y")]);
    expect(Object.keys(f.place).sort()).toEqual(["x", "y"]);
    expect(f.name).toBe("Renamed elsewhere");
    // Window 1's open board gets the other window's items, once
    expect(merges).toEqual([expect.objectContaining({ cards: { set: [note("y")] }, place: { set: { y: { x: 200, y: 0, w: 100 } } } })]);
    expect(w1.peek("A")!.cards.map((c) => c.id)).toEqual(["x", "y"]);
    // Deletes still go through: window 1 deletes x, which window 2 never changed
    await patchNow(w1, "A", { cards: { del: ["x"] }, place: { del: ["x"] } });
    await patchNow(w2, "A", { cards: { set: [note("y", "y2")] } });
    expect(JSON.parse(fs.files.get(`${ROOT}/A.json`)!.data as string).cards).toEqual([note("y", "y2")]);
  });

  /** Two windows whose storages watch the shared folder; settled() lets the watchers run and window 1 handle what they saw */
  function watching() {
    const fs = new MemFs();
    const w1 = new Storage(fs, { dir: () => ROOT, watch: fs.watch }), w2 = new Storage(fs, { dir: () => ROOT, watch: fs.watch });
    const settled = async () => { await new Promise((r) => setTimeout(r, 0)); await w1.flush(); await w2.flush(); };
    return { fs, w1, w2, settled };
  }

  it("an open board shows what another window wrote to its file without saving itself", async () => {
    const { fs, w1, w2, settled } = watching();
    const a = emptyBoard("A", "A");
    a.cards.push(note("x")); a.place.x = { x: 0, y: 0, w: 100 };
    await w1.save(a);
    await w2.load("A");
    await settled();
    const merges: unknown[] = [], writes = () => fs.files.get(`${ROOT}/A.json`)!.mtime;
    let changed = 0;
    w1.onDidMerge((e) => merges.push(e));
    w1.onDidChange(() => changed++);
    // Window 1's own write is not news to it
    await patchNow(w1, "A", { cards: { set: [note("x", "mine")] } });
    await settled();
    expect(merges).toEqual([]);
    // Window 2 adds a card and renames the board; window 1 never saves
    await patchNow(w2, "A", { cards: { set: [note("y")] }, place: { set: { y: { x: 200, y: 0, w: 100 } } }, head: { ...headOf(a), name: "Renamed elsewhere" } });
    const written = writes();
    await settled();
    expect(merges).toEqual([{ id: "A", patch: expect.objectContaining({ cards: { set: [note("y")] }, place: { set: { y: { x: 200, y: 0, w: 100 } } } }) }]);
    expect(w1.peek("A")!.cards).toEqual([note("x", "mine"), note("y")]);
    expect(w1.peek("A")!.name).toBe("Renamed elsewhere");
    expect(changed).toBe(1); // the sidebar shows the new name
    expect(writes()).toBe(written); // window 1 wrote nothing back
    // Window 1's unsaved edit and window 2's next edit both survive
    await w1.patch("A", { cards: { set: [note("x", "mine again")] } });
    await patchNow(w2, "A", { cards: { set: [note("y", "y2")] } });
    await settled();
    expect(w1.peek("A")!.cards).toEqual([note("x", "mine again"), note("y", "y2")]);
    expect(JSON.parse(fs.files.get(`${ROOT}/A.json`)!.data as string).cards).toEqual([note("x", "mine again"), note("y", "y2")]);
  });

  it("an open board shows a shared card another window edited on a different board", async () => {
    const { w1, w2, settled } = watching();
    const a = emptyBoard("A", "A");
    a.cards.push(note("s")); a.place.s = { x: 0, y: 0, w: 100 };
    await w1.save(a);
    await w1.share("A", ["s"]);
    const C = (await w1.create("C")).id;
    await w1.offer(C, ["s"]);
    await patchNow(w1, C, { cards: { set: [note("s")] }, place: { set: { s: { x: 0, y: 0, w: 100 } } } });
    await w2.load("A");
    await settled();
    const shared: { from?: string; ids: string[]; items: string[] }[] = [];
    w1.onDidShare((e) => shared.push({ from: e.from, ids: e.cards.map((c) => c.card.id), items: e.cards.flatMap((c) => c.items) }));
    await patchNow(w2, "A", { cards: { set: [note("s", "edited in window 2")] } });
    await settled();
    expect(shared).toEqual([{ from: undefined, ids: ["s"], items: ["s"] }]);
    expect(w1.peek(C)!.cards).toEqual([note("s", "edited in window 2")]);
    expect(w1.peek("A")!.cards).toEqual([note("s", "edited in window 2")]);
  });

  it("a card one window deleted takes along the link another window drew to it when the edits merge", async () => {
    const fs = new MemFs();
    const w1 = new Storage(fs, { dir: () => ROOT }), w2 = new Storage(fs, { dir: () => ROOT });
    const a = emptyBoard("A", "A");
    a.cards.push(note("x"), note("y")); a.place.x = { x: 0, y: 0, w: 100 }; a.place.y = { x: 200, y: 0, w: 100 };
    await w1.save(a);
    await w2.load("A");
    await patchNow(w1, "A", { cards: { del: ["x"] }, place: { del: ["x"] } });
    // Window 2 has not seen the delete and links y to x
    await patchNow(w2, "A", { links: { set: [{ id: "l", from: { card: "y" }, to: { card: "x" } }] } });
    const f = JSON.parse(fs.files.get(`${ROOT}/A.json`)!.data as string);
    expect(f.cards).toEqual([note("y")]);
    expect(f.links).toEqual([]);
    expect(danglingRefs(f)).toEqual([]);
    expect(w2.peek("A")!.links).toEqual([]);
  });

  it("a card another window deleted takes along the sidenote this window put on it while still unsaved", async () => {
    const { fs, w1, w2, settled } = watching();
    const a = emptyBoard("A", "A");
    a.cards.push(note("x"), note("y")); a.place.x = { x: 0, y: 0, w: 100 }; a.place.y = { x: 200, y: 0, w: 100 };
    await w1.save(a);
    await w2.load("A");
    await settled();
    await w2.patch("A", { sidenotes: { set: [{ id: "n", kind: "text", md: "on x", at: { card: "x" } }] } }); // not written yet
    await patchNow(w1, "A", { cards: { del: ["x"] }, place: { del: ["x"] } });
    await settled();
    expect(w2.peek("A")!.cards).toEqual([note("y")]);
    expect(w2.peek("A")!.sidenotes).toEqual([]);
    const f = JSON.parse(fs.files.get(`${ROOT}/A.json`)!.data as string);
    expect([f.cards, f.sidenotes, danglingRefs(f)]).toEqual([[note("y")], [], []]);
  });

  it("lines a shared card update moves on another board are written through the merge, keeping that window's edits to the board", async () => {
    const fs = new MemFs();
    const w1 = new Storage(fs, { dir: () => ROOT }), w2 = new Storage(fs, { dir: () => ROOT });
    const seg = (start: number, text: string[], commit: string) => ({ id: "g", src: { kind: "repo" as const, repo: "" }, path: "a.py", lang: "python", start, end: start + text.length - 1, text, version: { kind: "git" as const, commit } });
    const code = (sg: ReturnType<typeof seg>) => ({ id: "s", kind: "code" as const, segments: [sg] });
    const a = { ...emptyBoard("A", "A"), cards: [code(seg(10, ["def f():", "    x = 1", "    return x"], "a")), note("z")], place: { s: { x: 0, y: 0, w: 1 }, z: { x: 0, y: 0, w: 1 } } };
    await w1.save(a);
    await w1.share("A", ["s"]);
    const B = (await w1.duplicate("A"))!.id;
    const z = w1.peek(B)!.cards.find((c) => c.id !== "s")!.id;
    await patchNow(w1, B, { links: { set: [{ id: "l", from: { card: z }, to: { card: "s", seg: "g", line: 12 } }] } });
    // Window 2 adds a card to B; window 1 has not read it
    await w2.load(B);
    await patchNow(w2, B, { cards: { set: [note("w")] }, place: { set: { w: { x: 0, y: 300, w: 1 } } } });
    // Window 1 updates the shared card on A: B's link moves two lines down
    await patchNow(w1, "A", { cards: { set: [code(seg(10, ["# a", "# b", "def f():", "    x = 2", "    return x"], "b"))] } });
    const fb = JSON.parse(fs.files.get(`${ROOT}/${B}.json`)!.data as string);
    expect(fb.links[0].to).toEqual({ card: "s", seg: "g", line: 14 });
    expect(fb.cards.map((c: { id: string }) => c.id)).toEqual(["s", z, "w"]);
  });

  it("changes not yet written survive the sidebar reading a board file another window just wrote", async () => {
    const fs = new MemFs();
    const w1 = new Storage(fs, { dir: () => ROOT }), w2 = new Storage(fs, { dir: () => ROOT });
    const a = emptyBoard("A", "A");
    a.cards.push(note("x")); a.place.x = { x: 0, y: 0, w: 100 };
    await w1.save(a);
    await w2.load("A");
    await w1.patch("A", { cards: { set: [note("x", "edited here")] } });
    await patchNow(w2, "A", { cards: { set: [note("y")] }, place: { set: { y: { x: 200, y: 0, w: 100 } } } });
    await w1.list();
    expect((w1.peek("A")!.cards[0] as any).md).toBe("edited here");
    await w1.flush();
    expect(JSON.parse(fs.files.get(`${ROOT}/A.json`)!.data as string).cards).toEqual([note("x", "edited here"), note("y")]);
  });
});

describe("read-modify-write in the write queue", () => {
  const note = (id: string, md = id) => ({ id, kind: "note" as const, md, bg: true });
  it("rename, move and update never overwrite a patch that arrived before them with an older copy", async () => {
    const { fs, store } = setup();
    const a = emptyBoard("A", "A");
    a.cards.push(note("x")); a.place.x = { x: 0, y: 0, w: 100 };
    await store.save(a);
    let release!: () => void;
    fs.hold = new Promise((r) => { release = r; });
    // A slow write keeps the queue busy; a patch, a rename, a move and an update line up behind it
    const slow = store.save(emptyBoard("Other", "Other"));
    const patched = store.patch("A", { cards: { set: [note("y")] }, place: { set: { y: { x: 200, y: 0, w: 100 } } } });
    const renamed = store.rename("A", "Renamed");
    const moved = store.move("A", "G");
    const updated = store.update("A", (b) => { b.cards.push(note("z")); b.place.z = { x: 400, y: 0, w: 100 }; });
    fs.hold = null; release();
    await Promise.all([slow, patched, renamed, moved, updated]);
    await store.flush();
    const f = JSON.parse(fs.files.get(`${ROOT}/G/A.json`)!.data as string);
    expect([f.name, f.cards.map((c: { id: string }) => c.id)]).toEqual(["Renamed", ["x", "y", "z"]]);
    expect(fs.files.has(`${ROOT}/A.json`)).toBe(false);
    expect(await store.update("missing", () => {})).toBe(null);
  });
});

describe("undo and redo of Turn into Board", () => {
  const note = (id: string, md = id) => ({ id, kind: "note" as const, md, bg: true });
  const made = () => { const b = emptyBoard("child", "Child"); b.cards.push(note("x")); b.place.x = { x: 0, y: 0, w: 100 }; return b; };
  it("undo keeps a sub-board edited since it was made; redo links to that board", async () => {
    const { fs, store } = setup();
    await store.save(made(), { group: null });
    await patchNow(store, "child", { cards: { set: [note("x", "edited in the sub-board")] } });
    expect(await store.dropIfUnchanged("child", made())).toBe(false);
    const f = JSON.parse(fs.files.get(`${ROOT}/child.json`)!.data as string);
    expect(f.cards).toEqual([note("x", "edited in the sub-board")]);
    expect(await store.restore("child")).toBe(false); // nothing in the trash: redo keeps the board that is there
    expect((await store.load("child"))!.cards).toEqual([note("x", "edited in the sub-board")]);
  });
  it("undo trashes a sub-board nobody changed (moving the camera is no change); redo brings that file back", async () => {
    const { fs, store } = setup();
    await store.save(made(), { group: null });
    await patchNow(store, "child", { cam: { x: 50, y: 60, z: 2 } });
    expect(await store.dropIfUnchanged("child", made())).toBe(true);
    expect(fs.files.has(`${ROOT}/child.json`)).toBe(false);
    expect(await store.load("child")).toBe(null);
    expect(await store.restore("child", "G")).toBe(true);
    expect(fs.files.has(`${ROOT}/G/child.json`)).toBe(true);
    expect((await store.load("child"))!).toMatchObject({ cards: [note("x")], cam: { x: 50, y: 60, z: 2 } });
    expect(await store.restore("child")).toBe(false);
  });
});

describe("removing boards", () => {
  it("removing a board moves it to the trash and says which board went", async () => {
    const { fs, store } = setup();
    const b = await store.create("Gone");
    const gone: string[] = [];
    store.onDidRemoveBoard((id) => gone.push(id));
    await store.remove(b.id);
    expect(gone).toEqual([b.id]);
    expect(fs.files.has(`${ROOT}/${b.id}.json`)).toBe(false);
    expect([...fs.files.keys()].some((k) => k.startsWith(`${ROOT}/.trash/${b.id}.`))).toBe(true);
  });
});

describe("writing boards to disk", () => {
  const note = (id: string, md = id) => ({ id, kind: "note" as const, md, bg: true });
  const at = { x: 0, y: 0, w: 1 };
  const onDisk = (fs: MemFs, f: string) => JSON.parse(fs.files.get(f)!.data as string);

  it("a board's changes are in the storage at once and written together a moment later or on flush", async () => {
    const { fs, store } = setup();
    const b = await store.create("B");
    const file = `${ROOT}/${b.id}.json`;
    const writes = fs.clock;
    await store.patch(b.id, { cards: { set: [note("x")] }, place: { set: { x: at } } });
    await store.patch(b.id, { cards: { set: [note("x", "edited")] } });
    expect((store.peek(b.id)!.cards[0] as any).md).toBe("edited");
    expect((await store.load(b.id))!.cards.map((c) => c.id)).toEqual(["x"]);
    expect(onDisk(fs, file).cards).toEqual([]);
    await store.flush(b.id);
    expect(onDisk(fs, file).cards).toEqual([note("x", "edited")]);
    expect(fs.clock - writes).toBe(1); // one board file write for both patches
    await store.patch(b.id, { cards: { set: [note("x", "later")] } });
    await new Promise((r) => setTimeout(r, 600));
    expect(onDisk(fs, file).cards).toEqual([note("x", "later")]);
  });

  it("a failed write is reported once however often the retry fails, and once more when it gets through; the changes stay in the storage", async () => {
    const { fs, store } = setup();
    const b = await store.create("B");
    const failed: unknown[] = [], recovered: string[] = [];
    store.onDidFailSave((e) => failed.push(e));
    store.onDidRecoverSave((id) => recovered.push(id));
    const write = fs.writeFile.bind(fs);
    fs.writeFile = async () => { throw new Error("disk full"); };
    await store.patch(b.id, { cards: { set: [note("x")] }, place: { set: { x: at } } });
    await store.flush();
    await store.flush();
    await store.flush();
    expect(failed).toEqual([{ board: b.id, error: "disk full" }]);
    expect(recovered).toEqual([]);
    fs.writeFile = write;
    await store.flush();
    expect(onDisk(fs, `${ROOT}/${b.id}.json`).cards).toEqual([note("x")]);
    expect(recovered).toEqual([b.id]);
    await patchNow(store, b.id, { cards: { set: [note("y")] }, place: { set: { y: at } } });
    expect([failed.length, recovered.length]).toEqual([1, 1]);
  });

  it("a board deleted while its last changes are being written stays deleted", async () => {
    const { fs, store } = setup();
    const b = await store.create("B");
    const p = store.patch(b.id, { cards: { set: [note("x")] }, place: { set: { x: at } } });
    const flushed = store.flush(b.id);
    await store.remove(b.id);
    await Promise.all([p, flushed, store.flush()]);
    expect(await store.list()).toEqual([]);
    expect(fs.files.has(`${ROOT}/${b.id}.json`)).toBe(false);
    // pending changes of a deleted board are dropped, not written back
    const c = await store.create("C");
    await store.patch(c.id, { cards: { set: [note("y")] }, place: { set: { y: at } } });
    await store.remove(c.id);
    await store.flush();
    expect(await store.list()).toEqual([]);
  });

  it("renaming a group while a board in it is being saved leaves one copy, in the renamed folder", async () => {
    const { fs, store } = setup();
    const b = await store.create("B");
    await store.newGroup("G");
    await store.move(b.id, "G");
    const p = store.patch(b.id, { cards: { set: [note("x")] }, place: { set: { x: at } } });
    const flushed = store.flush(b.id);
    await store.renameGroup("G", "H");
    await Promise.all([p, flushed, store.flush()]);
    const copies = [...fs.files.keys()].filter((f) => f.endsWith(`/${b.id}.json`));
    expect(copies).toEqual([`${ROOT}/H/${b.id}.json`]);
    expect(onDisk(fs, copies[0]).cards).toEqual([note("x")]);
    expect(fs.dirs.has(`${ROOT}/G`)).toBe(false);
  });

  it("changing the storage folder first writes pending changes to the board's own file", async () => {
    const fs = new MemFs();
    let root = ROOT;
    const store = new Storage(fs, { dir: () => root });
    const b = await store.create("B");
    await store.patch(b.id, { cards: { set: [note("x")] }, place: { set: { x: at } } });
    root = "/elsewhere";
    await store.reset();
    expect(onDisk(fs, `${ROOT}/${b.id}.json`).cards).toEqual([note("x")]);
    expect([...fs.files.keys()].some((f) => f.startsWith("/elsewhere"))).toBe(false);
  });
});

describe("sub-boards in the library", () => {
  it("lists each board's sub-boards and tells the sidebar when a frame is added or removed", async () => {
    const { store } = setup();
    const parent = await store.create("Engine");
    const child = await store.create("Scheduler");
    let changed = 0;
    store.onDidChange(() => changed++);
    await patchNow(store, parent.id, { cards: { set: [{ id: "f", kind: "board", board: child.id }] }, place: { set: { f: { x: 0, y: 0, w: 560, h: 360 } } } });
    expect(changed).toBe(1);
    expect((await store.list()).find((m) => m.id === parent.id)?.subs).toEqual([child.id]);
    expect((await store.list()).find((m) => m.id === child.id)?.subs).toBeUndefined();
    await patchNow(store, parent.id, { place: { set: { f: { x: 50, y: 0, w: 560, h: 360 } } } });
    expect(changed).toBe(1); // moving the frame is not a sidebar change
    await patchNow(store, parent.id, { cards: { del: ["f"] }, place: { del: ["f"] } });
    expect(changed).toBe(2);
    expect((await store.list()).find((m) => m.id === parent.id)?.subs).toBeUndefined();
  });
});
