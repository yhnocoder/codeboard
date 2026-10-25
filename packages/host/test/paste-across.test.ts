// Cards copied (⌘C) in one window paste (⌘V) on a board in another window with another storage folder: they arrive as independent
// copies, with code sources rewritten for this workspace and the images and run records they use copied into this storage folder
import * as fs from "node:fs";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { emptyBoard, placeCards, type Board, type BoardToHost, type CodeCard, type Segment, type Source } from "@codeboard/core";
import { Storage, type Pasted } from "@codeboard/core/storage";
import { nodeFs } from "../src/nodefs";
import { useWorkspace } from "../src/ws";
import { makeHandler } from "../src/handlers";
import type { BoardHost, BoardPanel } from "../src/boards";
import { nodeWorkspace } from "./node-workspace";
import { sleep, tempRepo } from "./helpers";

const tmp: string[] = [];
const mk = (p: string) => { const d = fs.mkdtempSync(`/tmp/codeboard-${p}-`); tmp.push(d); return d; };
/** 窗口 A 的工作区（仓库 A）、窗口 B 的工作区（里面有 B/lib）、两个窗口共用的全局存储目录 G */
let A: string, B: string, G: string;
let n = 0;

const seg = (src: Source, p = "x.py"): Segment => ({ id: `s${++n}`, src, path: p, lang: "python", start: 1, end: 1, text: ["x = 1"], version: { kind: "none" } });
const code = (id: string, ...segs: Segment[]): CodeCard => ({ id, kind: "code", segments: segs });
const put = (b: Board, c: Board["cards"][number], x = 0) => { b.cards.push(c); b.place[c.id] = { x, y: 0, w: 400 }; };
const codeOf = (r: Pasted | null, id: string) => r?.cards.find((x) => x.card.id === id)?.card as CodeCard | undefined;

/** 一个窗口：它的工作区、存储目录、白板消息处理 */
function windowOf(folder: string) {
  const ws = nodeWorkspace(folder);
  ws.storage = { ...ws.storage, globalDir: () => G };
  const dir = mk("pdir");
  const store = new Storage(nodeFs, { dir: () => dir });
  const host = { store, clip: undefined, broadcast: () => undefined } as unknown as BoardHost;
  const h = makeHandler(host);
  const send = (board: string, m: Record<string, unknown>) => { useWorkspace(ws); return h({ id: board } as BoardPanel, { req: 1, ...m } as BoardToHost); };
  return { dir, store, host, send };
}

beforeAll(() => {
  A = tempRepo("pa", { "x.py": "x = 1\n" }); tmp.push(A);
  B = mk("pb");
  fs.mkdirSync(path.join(B, "lib"));
  fs.writeFileSync(path.join(B, "lib/x.py"), "x = 1\n");
  G = mk("pg");
});
afterAll(() => { for (const d of tmp) fs.rmSync(d, { recursive: true, force: true }); });

/** 窗口 A 上一块白板：带图片的 Note、仓库 A 里的代码卡（Generated，用到一份运行记录）、B/lib 里的代码卡、它们之间的 Link */
async function source() {
  const a = windowOf(A);
  const M = emptyBoard("bMain", "Main");
  put(M, { id: "note", kind: "note", md: "see ![x](assets/def456-40x30.png)", bg: true });
  const k = code("k1", seg({ kind: "repo", repo: "" }));
  k.gen = { what: "CUDA source", run: "r1" };
  put(M, k, 500);
  put(M, code("k2", seg({ kind: "external", root: path.join(B, "lib") })), 1000);
  M.links.push({ id: "l1", from: { card: "note" }, to: { card: "k1" } } as Board["links"][number]);
  await a.store.save(M);
  fs.mkdirSync(path.join(a.dir, "assets"));
  fs.writeFileSync(path.join(a.dir, "assets/def456-40x30.png"), "png");
  fs.writeFileSync(path.join(a.dir, "assets/unused.png"), "nope");
  fs.mkdirSync(path.join(a.dir, "runs"));
  fs.writeFileSync(path.join(a.dir, "runs/r1.json"), "{}");
  return a;
}

async function copied(a: ReturnType<typeof windowOf>, text: string) {
  await a.send("bMain", { type: "copyCards", cards: ["note", "k1", "k2"], text });
  for (let i = 0; i < 100 && !fs.existsSync(path.join(G, "clipboard.json")); i++) await sleep(10);
  await sleep(20);
}

describe("paste cards from another window", () => {
  it("brings copies of the cards, their image and run record, with sources for this workspace", async () => {
    const a = await source();
    await copied(a, "Note and two cards");
    const b = windowOf(B);
    await b.store.save(emptyBoard("bHere", "Here"));
    const fileBefore = fs.readFileSync(path.join(a.dir, "bMain.json"), "utf8");

    const r = (await b.send("bHere", { type: "pasteCards", text: "Note and two cards\r\n", copy: false })) as Pasted | null;
    expect(r?.shared).toBe(false);
    expect(r?.from).toBe(`Main (${path.basename(A)})`);
    expect(r?.cards.map((x) => x.card.id).sort()).toEqual(["k1", "k2", "note"]);
    expect(r?.links.map((l) => l.id)).toEqual(["l1"]);
    // Note 的 Markdown 不变，图片拷到了这边的 assets/（没用到的不拷）
    expect((r?.cards.find((x) => x.card.id === "note")?.card as { md: string }).md).toBe("see ![x](assets/def456-40x30.png)");
    expect(fs.readFileSync(path.join(b.dir, "assets/def456-40x30.png"), "utf8")).toBe("png");
    expect(fs.existsSync(path.join(b.dir, "assets/unused.png"))).toBe(false);
    expect(fs.existsSync(path.join(b.dir, "runs/r1.json"))).toBe(true);
    // 仓库 A 不在 B 的工作区里 → 外部路径；B/lib 在 → 相对它的 repo
    expect(codeOf(r, "k1")?.segments[0].src).toEqual({ kind: "external", root: A });
    expect(codeOf(r, "k2")?.segments[0].src).toEqual({ kind: "repo", repo: "lib" });
    // 放到白板上是独立副本：新 id，Link 跟着换
    const here = (await b.store.load("bHere"))!;
    const m = placeCards(here, r!.cards, { copy: !r!.shared, links: r!.links });
    expect(Object.keys(m.cards).sort()).toEqual(["k1", "k2", "note"]);
    for (const [o, x] of Object.entries(m.cards)) expect(x).not.toBe(o);
    expect(here.links).toHaveLength(1);
    expect(here.links[0].from.card).toBe(m.cards.note);
    // 那边一点没动：白板文件一样，没有卡库
    expect(fs.readFileSync(path.join(a.dir, "bMain.json"), "utf8")).toBe(fileBefore);
    expect(fs.existsSync(path.join(a.dir, "cards"))).toBe(false);
  });

  it("keeps an image already in this storage folder", async () => {
    const a = await source();
    await copied(a, "again");
    const b = windowOf(B);
    await b.store.save(emptyBoard("bHere", "Here"));
    fs.mkdirSync(path.join(b.dir, "assets"));
    fs.writeFileSync(path.join(b.dir, "assets/def456-40x30.png"), "mine");
    expect(await b.send("bHere", { type: "pasteCards", text: "again", copy: true })).toBeTruthy();
    expect(fs.readFileSync(path.join(b.dir, "assets/def456-40x30.png"), "utf8")).toBe("mine");
  });

  it("is a text paste when the clipboard text differs, or with no text when the copy is old", async () => {
    const a = await source();
    await copied(a, "copied text");
    const b = windowOf(B);
    await b.store.save(emptyBoard("bHere", "Here"));
    expect(await b.send("bHere", { type: "pasteCards", text: "something else", copy: false })).toBeNull();
    expect(fs.existsSync(path.join(b.dir, "assets"))).toBe(false);
    // 菜单粘贴（不核对文字）：刚复制的认，很久以前复制的不认
    expect(await b.send("bHere", { type: "pasteCards", copy: false })).toBeTruthy();
    const file = path.join(G, "clipboard.json");
    fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(fs.readFileSync(file, "utf8")), at: Date.now() - 3600_000 }));
    expect(await b.send("bHere", { type: "pasteCards", copy: false })).toBeNull();
  });

  it("pastes copies from another window on the same storage folder", async () => {
    const a = await source();
    await copied(a, "same folder");
    // 同一个项目的第二个窗口：同一个存储目录，自己的剪贴板是空的
    const ws2 = { store: new Storage(nodeFs, { dir: () => a.dir }), clip: undefined, broadcast: () => undefined } as unknown as BoardHost;
    await ws2.store.save(emptyBoard("bOther", "Other"));
    const r = (await makeHandler(ws2)({ id: "bOther" } as BoardPanel, { type: "pasteCards", req: 1, text: "same folder", copy: false } as BoardToHost)) as Pasted | null;
    expect(r?.shared).toBe(false);
    expect(codeOf(r, "k1")?.segments[0].src).toEqual({ kind: "repo", repo: "" });
  });
});
