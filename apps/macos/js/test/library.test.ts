import { afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { emptyBoard } from "@codeboard/core";
import { createBridge } from "../bridge";
import { createLibrary } from "../library";
import { nodeNative } from "./node-native";

const tmps: string[] = [];
afterEach(() => {
  for (const t of tmps.splice(0)) fs.rmSync(t, { recursive: true, force: true });
});
function folder() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "codeboard-lib-"));
  tmps.push(d);
  const b = emptyBoard("b1", "Scheduler");
  b.cards.push({
    id: "n1",
    kind: "note",
    md: "# Prefill\n\nHow prefill is batched.\n\n![](assets/aaaa.png)",
    look: "note",
  });
  b.place.n1 = { x: 10, y: 20, w: 300 };
  const { cam: _cam, ...file } = b;
  fs.writeFileSync(path.join(d, "b1.json"), JSON.stringify(file));
  return d;
}

function library() {
  const native = nodeNative();
  const bridge = createBridge(native, { timers: false });
  return createLibrary(native, (dir) => bridge.folder(dir).storage);
}

describe("library", () => {
  it("lists boards with their file's time and a small map of their cards", async () => {
    const dir = folder();
    const lib = library();
    const [b] = await lib.list(dir);
    expect(b).toMatchObject({ id: "b1", name: "Scheduler", cards: 1 });
    expect(b.mtime).toBeGreaterThan(0);
    expect(b.map.cards[0]).toMatchObject({ x: 10, y: 20, w: 300, kind: "note", title: "Prefill", look: "note" });
  });

  it("makes, renames and deletes boards the way the extension does (deleted ones go to .trash)", async () => {
    const dir = folder();
    const lib = library();
    const id = await lib.create(dir, "New Board");
    expect(fs.existsSync(path.join(dir, `${id}.json`))).toBe(true);
    await lib.rename(dir, id, "Decode");
    expect(JSON.parse(fs.readFileSync(path.join(dir, `${id}.json`), "utf8")).name).toBe("Decode");
    await lib.remove(dir, id);
    expect(fs.existsSync(path.join(dir, `${id}.json`))).toBe(false);
    expect(fs.readdirSync(path.join(dir, ".trash")).some((n) => n.startsWith(`${id}.`))).toBe(true);
    expect((await lib.list(dir)).map((b) => b.id)).toEqual(["b1"]);
  });

  it("hands box each card with where it is and its pictures, without the data of those box has", async () => {
    const dir = folder();
    fs.mkdirSync(path.join(dir, "assets"));
    fs.writeFileSync(path.join(dir, "assets", "aaaa.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    const lib = library();
    const [d] = await lib.docs(dir);
    expect(d).toMatchObject({ id: "card:n1", groups: ["b1"], origin: { kind: "card", board: "b1", card: "n1" } });
    expect(d.text).toContain("prefill is batched");
    expect(d.images).toEqual([{ key: "aaaa.png", url: "data:image/png;base64,iVBORw==" }]);
    const [again] = await lib.docs(dir, ["aaaa.png"]);
    expect(again.images).toEqual([{ key: "aaaa.png" }]);
  });
});
