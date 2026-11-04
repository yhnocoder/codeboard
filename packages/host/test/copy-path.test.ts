// Copy Path: where a board, a card and a Section are on disk, as Claude Code in a terminal would open and grep them
import * as fs from "node:fs";
import * as path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { emptyBoard, type Board } from "@codeboard/core";
import { BoardPlace } from "../src/storage/place";
import { itemPaths } from "../src/paths";
import { HostContext } from "../src/context";
import { nodeWorkspace } from "./node-workspace";
import { tempRepo } from "./helpers";

const tmp: string[] = [];
afterAll(() => {
  for (const d of tmp) fs.rmSync(d, { recursive: true, force: true });
});

/** A workspace on a fresh repo; inProject: its boards in .codeboard/ (else in the extension's storage folder, outside the repo) */
function setup(inProject: boolean) {
  const repo = tempRepo("copypath", { "x.py": "x = 1\n" });
  const wsDir = fs.mkdtempSync("/tmp/codeboard-copypath-store-");
  tmp.push(repo, wsDir);
  if (inProject) fs.mkdirSync(path.join(repo, ".codeboard"));
  const W = nodeWorkspace(repo);
  W.storage = {
    dir: () => wsDir,
    globalDir: () => path.join(wsDir, "global"),
    get: () => undefined,
    set: async () => {},
  };
  const cx = new HostContext(W);
  const place = new BoardPlace(cx);
  return { cx, store: place.store, repo, wsDir, dispose: () => place.dispose() };
}

function boards(): Board[] {
  const A = emptyBoard("bA", "Attention");
  A.cards.push({ id: "n1", kind: "note", md: "a note", look: "note" });
  A.cards.push({ id: "sh", kind: "note", md: "a shared note", look: "note" });
  A.cards.push({ id: "fr", kind: "board", board: "bSub" });
  A.place.n1 = { x: 0, y: 0, w: 200 };
  A.place.sh = { x: 300, y: 0, w: 200 };
  A.place.fr = { x: 600, y: 0, w: 300, h: 200 };
  A.sections.push({ id: "s1", title: "Prefill", x: -20, y: -20, w: 600, h: 300 });
  const S = emptyBoard("bSub", "Sub");
  return [A, S];
}

describe("copy path", () => {
  it("gives the file relative to the workspace folder, with the id that is in that file", async () => {
    const t = setup(true);
    for (const b of boards()) await t.store.save(b);
    await t.store.share("bA", ["sh"]);
    await t.store.flush();
    expect(await itemPaths(t.cx, t.store, "bA")).toBe(".codeboard/bA.json");
    const text = await itemPaths(t.cx, t.store, "bA", ["n1", "s1", "sh", "fr"]);
    // the shared card's content is in the card library; a sub-board's frame points at that board's own file
    expect(text).toBe(
      [".codeboard/bA.json#n1", ".codeboard/bA.json#s1", ".codeboard/cards/sh.json#sh", ".codeboard/bSub.json"].join(
        "\n",
      ),
    );
    for (const line of text!.split("\n")) {
      const [file, id] = line.split("#");
      const body = fs.readFileSync(path.join(t.repo, file), "utf8");
      if (id) expect(body).toContain(`"id": "${id}"`);
    }
    // the file is named by the board's id: renaming the board keeps the path
    await t.store.rename("bA", "Attention, renamed");
    expect(await itemPaths(t.cx, t.store, "bA", ["n1"])).toBe(".codeboard/bA.json#n1");
    t.dispose();
  });

  it("gives an absolute path when the boards are outside the workspace folder", async () => {
    const t = setup(false);
    for (const b of boards()) await t.store.save(b);
    await t.store.flush();
    expect(await itemPaths(t.cx, t.store, "bA", ["n1"])).toBe(`${path.join(t.wsDir, "boards", "bA.json")}#n1`);
    expect(await itemPaths(t.cx, t.store, "nope")).toBe(null);
    t.dispose();
  });
});
