import * as fs from "node:fs";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { emptyBoard } from "@codeboard/core";
import { Storage } from "@codeboard/core/storage";
import { nodeFs } from "../src/nodefs";
import { makeActions } from "../src/actions";
import { treeChildren } from "../src/boardtree";
import type { BoardHost } from "../src/boards";
import { useWorkspace } from "../src/ws";
import { nodeWorkspace } from "./node-workspace";

const W = nodeWorkspace();
const dir = fs.mkdtempSync("/tmp/codeboard-broken-");
const store = new Storage(nodeFs, { dir: () => dir });
const shown: string[] = [], errors: string[] = [], opened: string[] = [];
const panels = { store, target: undefined, get: () => undefined, all: () => [], setTarget: () => {}, show: async (id: string) => { shown.push(id); return undefined; } } as unknown as BoardHost;
W.ui.error = (async (text: string) => { errors.push(text); return "Open JSON"; }) as typeof W.ui.error;
W.editor.open = async (abs) => { opened.push(abs); };

const file = path.join(dir, "g", "luna.json");
const bad = JSON.stringify({ ...emptyBoard("luna", "Luna's notes"), cards: [{ kind: "nope" }] });

beforeAll(() => { useWorkspace(W); fs.mkdirSync(path.dirname(file)); fs.writeFileSync(file, bad); });
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

describe("a board file that can't be read", () => {
  it("is listed in its group in the Boards tree with the reason", async () => {
    const metas = await store.list();
    const g = treeChildren(metas, await store.groups(), undefined, store.broken()).find((n) => n.kind === "group")!;
    const kids = treeChildren(metas, [], g, store.broken());
    expect(kids).toHaveLength(1);
    expect(kids[0].kind === "broken" && kids[0].bad).toMatchObject({ file, name: "Luna's notes", group: "g", reason: expect.stringMatching(/^Invalid board/) });
  });

  it("opening it shows the reason, opens the JSON and never writes the file", async () => {
    const before = fs.statSync(file).mtimeMs;
    const acts = makeActions(panels, store);
    await acts["codeboard.openBrokenBoard"](file);
    await acts["codeboard.openBoard"]("luna", { here: true });
    await store.flush();
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("Luna's notes");
    expect(errors[0]).toContain("Invalid board");
    expect(opened).toEqual([file]);
    expect(fs.readFileSync(file, "utf8")).toBe(bad);
    expect(fs.statSync(file).mtimeMs).toBe(before);
    expect(fs.readdirSync(path.dirname(file))).toEqual(["luna.json"]);
  });

  it("opens as a board again once the file is fixed on disk", async () => {
    fs.writeFileSync(file, JSON.stringify(emptyBoard("luna", "Luna's notes")));
    expect((await store.list()).map((m) => m.name)).toEqual(["Luna's notes"]);
    expect(store.broken()).toEqual([]);
    await makeActions(panels, store)["codeboard.openBrokenBoard"](file);
    expect(shown.at(-1)).toBe("luna");
  });
});
