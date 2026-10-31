// Boards kept in the project (.codeboard/ in the first workspace folder): picked up without a setting, moved there by
// Move Boards into Project, the camera kept per machine, and boards reloaded when git changes the files under an open board.
import * as fs from "node:fs";
import * as path from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { emptyBoard, type Board, type HostToBoard } from "@codeboard/core";
import type { Storage } from "@codeboard/core/storage";
import { BoardHub } from "../src/hub";
import type { HostEnv } from "../src/env";
import { useWorkspace } from "../src/ws";
import { followStorageDir, moveIntoProject, onDidSwitchStorage, openStorage } from "../src/storage";
import { nodeWorkspace, type TestWorkspace } from "./node-workspace";
import { git, stubView, tempRepo } from "./helpers";

const tmp: string[] = [];
afterAll(() => {
  for (const d of tmp) fs.rmSync(d, { recursive: true, force: true });
});

/** A workspace on a fresh repo with its own workspace storage, workspace state and settings */
function setup() {
  const repo = tempRepo("proj", { "x.py": "x = 1\n" });
  const wsDir = fs.mkdtempSync("/tmp/codeboard-wsstore-");
  tmp.push(repo, wsDir);
  const state = new Map<string, unknown>(),
    settings = new Map<string, unknown>();
  const W: TestWorkspace = nodeWorkspace(repo);
  W.storage = {
    dir: () => wsDir,
    globalDir: () => path.join(wsDir, "global"),
    get: <T>(k: string) => state.get(k) as T,
    set: async (k, v) => {
      state.set(k, v);
    },
  };
  W.settings = { ...W.settings, get: <T>(k: string) => settings.get(k) as T };
  useWorkspace(W);
  return { W, repo, state, settings, outside: path.join(wsDir, "boards"), inside: path.join(repo, ".codeboard") };
}
const json = (f: string) => JSON.parse(fs.readFileSync(f, "utf8"));
/** A hub with these boards open and ready, each in its own stub view */
async function hubOn(store: Storage, ids: string[]) {
  const views = new Map<string, ReturnType<typeof stubView>>();
  const env: HostEnv = {
    globalState: { get: () => undefined, set: async () => undefined },
    openView: (id) => {
      const v = stubView();
      views.set(id, v);
      return v.view;
    },
  };
  const hub = new BoardHub(env, store);
  for (const id of ids) {
    const p = (await hub.show(id))!;
    p.board = store.peek(id);
    p.ready = true;
  }
  return { hub, views };
}
const stores: Storage[] = [];
const open = () => {
  const s = openStorage();
  stores.push(s);
  return s;
};
afterAll(() => {
  for (const s of stores) s.dispose();
});

describe("boards in the project", () => {
  it("uses .codeboard in the first folder when it exists, workspace storage otherwise; codeboard.storageDir wins", async () => {
    const s = setup();
    expect(open().dir()).toBe(s.outside);
    fs.mkdirSync(s.inside);
    const store = open();
    expect(store.dir()).toBe(s.inside);
    s.settings.set("codeboard.storageDir", "notes");
    expect(await followStorageDir(store)).toBe(true);
    expect(store.dir()).toBe(path.join(s.repo, "notes"));
    s.settings.delete("codeboard.storageDir");
    expect(await followStorageDir(store)).toBe(true);
    expect(store.dir()).toBe(s.inside);
    expect(await followStorageDir(store)).toBe(false);
  });

  it("Move Boards into Project moves boards, groups, shared cards, images and runs into .codeboard, ignores the trash and switches to it", async () => {
    const s = setup();
    const store = open();
    const a = emptyBoard("bA", "A"),
      b = emptyBoard("bB", "B");
    a.cards.push({ id: "n", kind: "note", md: "shared", look: "note" });
    a.place.n = { x: 0, y: 0, w: 300 };
    await store.save(a);
    await store.save(b, { group: "G" });
    await store.share("bA", ["n"]);
    await store.saveAsset("p.png", "data:image/png;base64,iVBORw0KGgo=");
    fs.mkdirSync(path.join(s.outside, "runs"));
    fs.writeFileSync(path.join(s.outside, "runs/r1.json"), "{}");
    await store.remove("bB");
    const switched: string[] = [];
    const sub = onDidSwitchStorage((x) => switched.push(x.dir()));

    expect(await moveIntoProject(store)).toEqual({ moved: true, to: s.inside });
    sub.dispose();
    expect(switched).toEqual([s.inside]);
    expect(store.dir()).toBe(s.inside);
    expect(fs.existsSync(s.outside)).toBe(false);
    expect(fs.readFileSync(path.join(s.inside, ".gitignore"), "utf8")).toBe(".trash/\n*.tmp\n");
    expect(fs.existsSync(path.join(s.inside, "bA.json"))).toBe(true);
    expect(fs.existsSync(path.join(s.inside, "cards/n.json"))).toBe(true);
    expect(fs.readdirSync(path.join(s.inside, "assets"))).toHaveLength(1);
    expect(fs.existsSync(path.join(s.inside, "runs/r1.json"))).toBe(true);
    expect(fs.readdirSync(path.join(s.inside, ".trash"))).toHaveLength(1);
    expect((await store.list()).map((m) => m.id)).toEqual(["bA"]);
    expect((await store.load("bA"))!.cards[0]).toMatchObject({ md: "shared" });
    // What git sees: the boards, the library, the images and runs, never the trash
    git(s.repo, "add", "-A");
    const tracked = git(s.repo, "diff", "--cached", "--name-only").split("\n");
    expect(tracked.filter((f) => f.startsWith(".codeboard/")).every((f) => !f.startsWith(".codeboard/.trash/"))).toBe(
      true,
    );
    expect(tracked).toContain(".codeboard/bA.json");
    // A clone of the repository sees the boards without any setting
    git(s.repo, "commit", "-qm", "boards");
    const clone = fs.mkdtempSync("/tmp/codeboard-clone-");
    tmp.push(clone);
    git(clone, "clone", "-q", s.repo, "r");
    useWorkspace(nodeWorkspace(path.join(clone, "r")));
    expect((await open().list()).map((m) => m.name)).toEqual(["A"]);
  });

  it("refuses to merge into a .codeboard that already has boards, and with no folder open", async () => {
    const s = setup();
    const store = open();
    await store.save(emptyBoard("bA", "A"));
    fs.mkdirSync(path.join(s.inside, "G"), { recursive: true });
    fs.writeFileSync(path.join(s.inside, "G/other.json"), JSON.stringify(emptyBoard("other", "Other")));
    const r = await moveIntoProject(store);
    expect(r.moved).toBe(false);
    expect(r.moved === false && r.why).toMatch(/already has boards/);
    expect(fs.existsSync(path.join(s.outside, "bA.json"))).toBe(true);

    s.W.files.roots = () => [];
    expect((await moveIntoProject(store)).moved).toBe(false);
  });

  it("panning a board changes no file: the camera is kept in this machine's workspace state", async () => {
    const s = setup();
    fs.mkdirSync(s.inside);
    const store = open();
    const b = await store.create("B");
    const file = path.join(s.inside, `${b.id}.json`);
    const before = fs.readFileSync(file, "utf8"),
      mtime = fs.statSync(file).mtimeMs;
    await store.patch(b.id, { cam: { x: -500, y: 20, z: 0.75 } });
    await store.flush();
    expect(fs.readFileSync(file, "utf8")).toBe(before);
    expect(fs.statSync(file).mtimeMs).toBe(mtime);
    expect(json(file)).not.toHaveProperty("cam");
    expect(s.state.get("codeboard.cams")).toEqual({ [b.id]: { x: -500, y: 20, z: 0.75 } });
    expect((await open().load(b.id))!.cam).toEqual({ x: -500, y: 20, z: 0.75 });
  });

  it("an open board takes the changes a git checkout makes to its file", async () => {
    const s = setup();
    fs.mkdirSync(s.inside);
    const store = open();
    const b: Board = emptyBoard("bG", "Git");
    b.cards.push({ id: "n1", kind: "note", md: "first", look: "note" });
    b.place.n1 = { x: 0, y: 0, w: 300 };
    await store.save(b);
    git(s.repo, "add", "-A");
    git(s.repo, "commit", "-qm", "board");
    git(s.repo, "checkout", "-qb", "other");
    const f = path.join(s.inside, "bG.json");
    const changed = json(f);
    changed.cards.push({ id: "n2", kind: "note", md: "from a teammate", look: "note" });
    changed.place.n2 = { x: 400, y: 0, w: 300 };
    fs.writeFileSync(f, JSON.stringify(changed, null, 1));
    git(s.repo, "commit", "-qam", "teammate");
    git(s.repo, "checkout", "-q", "main");

    const v = stubView();
    const env: HostEnv = { globalState: { get: () => undefined, set: async () => undefined }, openView: () => v.view };
    const hub = new BoardHub(env, store);
    const p = (await hub.show("bG"))!;
    p.board = store.peek("bG");
    p.ready = true;

    git(s.repo, "checkout", "-q", "other"); // what a pull or checkout does under an open board
    s.W.fire.change.fire(f); // the file watcher's event
    await vi.waitFor(() => expect(v.posted.some((m) => m.type === "merged")).toBe(true));
    const m = v.posted.find((x): x is Extract<HostToBoard, { type: "merged" }> => x.type === "merged")!;
    expect(m.patch.cards?.set?.map((c) => c.id)).toEqual(["n2"]);
    expect(store.peek("bG")!.cards.map((c) => c.id)).toEqual(["n1", "n2"]);
    hub.dispose();
  });

  it("follows .codeboard appearing and going away (checking out a branch with or without it)", async () => {
    const s = setup();
    const store = open();
    await store.save(emptyBoard("bLocal", "Local"));
    git(s.repo, "checkout", "-qb", "boards");
    fs.mkdirSync(s.inside);
    fs.writeFileSync(
      path.join(s.inside, "bShared.json"),
      JSON.stringify({ ...emptyBoard("bShared", "Shared"), cam: undefined }),
    );
    git(s.repo, "add", "-A");
    git(s.repo, "commit", "-qm", "boards");
    expect(await followStorageDir(store)).toBe(true);
    expect((await store.list()).map((m) => m.id)).toEqual(["bShared"]);
    git(s.repo, "checkout", "-q", "main");
    expect(fs.existsSync(s.inside)).toBe(false);
    expect(await followStorageDir(store)).toBe(true);
    expect((await store.list()).map((m) => m.id)).toEqual(["bLocal"]);
  });

  it("a move changes nothing on the open boards", async () => {
    setup();
    const store = open();
    await store.save(emptyBoard("bA", "A"));
    await store.save(emptyBoard("bB", "B"));
    const { hub, views } = await hubOn(store, ["bA", "bB"]);
    expect((await moveIntoProject(store)).moved).toBe(true);
    await hub.followStorage();
    expect(
      hub
        .all()
        .map((p) => p.id)
        .sort(),
    ).toEqual(["bA", "bB"]);
    expect([...views.values()].flatMap((v) => v.posted.filter((m) => m.type === "merged"))).toEqual([]);
    hub.dispose();
  });

  it("checking out a branch with .codeboard: open boards it lacks close, the others take its version", async () => {
    const s = setup();
    const store = open();
    const a = emptyBoard("bA", "A");
    a.cards.push({ id: "n1", kind: "note", md: "mine", look: "note" });
    a.place.n1 = { x: 0, y: 0, w: 300 };
    await store.save(a);
    await store.save(emptyBoard("bB", "B"));
    git(s.repo, "checkout", "-qb", "boards");
    fs.mkdirSync(s.inside);
    const { cam: _cam, ...file } = {
      ...structuredClone(a),
      cards: [{ id: "n1", kind: "note", md: "from the repository", look: "note" }],
    };
    fs.writeFileSync(path.join(s.inside, "bA.json"), JSON.stringify(file, null, 1));
    git(s.repo, "add", "-A");
    git(s.repo, "commit", "-qm", "boards");
    git(s.repo, "checkout", "-q", "main");
    const { hub, views } = await hubOn(store, ["bA", "bB"]);

    git(s.repo, "checkout", "-q", "boards");
    expect(await followStorageDir(store)).toBe(true);
    await hub.followStorage();
    expect(hub.all().map((p) => p.id)).toEqual(["bA"]);
    const m = views.get("bA")!.posted.find((x): x is Extract<HostToBoard, { type: "merged" }> => x.type === "merged");
    expect(m?.patch.cards?.set).toEqual([{ id: "n1", kind: "note", md: "from the repository", look: "note" }]);
    hub.dispose();
  });
});
