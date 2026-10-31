// startHost wires a host from a Workspace and a HostEnv alone (what the VS Code extension and a Node sidecar both call): commands,
// views, settings broadcasts, following the storage directory, and dispose that unhooks all of it
import * as fs from "node:fs";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Emitter, type HostToBoard } from "@codeboard/core";
import type { HostEnv } from "../src/env";
import { startHost, type Host } from "../src/start";
import { excludeScratch, scratchName } from "../src/scratchnames";
import { nodeWorkspace } from "./node-workspace";
import { git, stubView, tempRepo } from "./helpers";

const tmp = fs.mkdtempSync("/tmp/codeboard-start-");
const root = path.join(tmp, "ws"),
  storage = path.join(tmp, "storage"),
  moved = path.join(tmp, "moved");
fs.mkdirSync(root);
const W = nodeWorkspace(root);
const settings = new Map<string, unknown>();
const changed = new Emitter<{ affects(key: string): boolean }>();
W.storage = { ...W.storage, dir: () => storage, globalDir: () => path.join(tmp, "global") };
W.settings = {
  get: <T>(k: string) => settings.get(k) as T,
  set: async (k, v) => {
    settings.set(k, v);
  },
  onDidChange: changed.event,
};
const change = (k: string, v: unknown) => {
  settings.set(k, v);
  changed.fire({ affects: (x) => x === k || k.startsWith(`${x}.`) });
};

const global = new Map<string, unknown>();
const views: ReturnType<typeof stubView>[] = [];
const env: HostEnv = {
  globalState: {
    get: <T>(k: string) => global.get(k) as T,
    set: async (k, v) => {
      global.set(k, v);
    },
  },
  openView: () => {
    const v = stubView();
    views.push(v);
    return v.view;
  },
};
const posted = (type: HostToBoard["type"]) => views.flatMap((v) => v.posted).filter((m) => m.type === type);

let host: Host;
beforeAll(async () => {
  host = startHost(W, env);
  await host.ready;
});
afterAll(() => {
  host.dispose();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("startHost", () => {
  it("opens the first board of the workspace from its Open Board command", async () => {
    await host.actions["codeboard.openBoard"]();
    expect((await host.store.list()).map((b) => b.name)).toEqual(["New Board"]);
    expect(views).toHaveLength(1);
    host.hub.all()[0].ready = true; // as if the board had said ready: messages go out instead of waiting for init
    expect(host.store.dir()).toBe(path.join(storage, "boards"));
  });
  it("records the project's storage directory for Copy to Another Project", () => {
    expect(
      Object.values(global.get("codeboard.projects") as Record<string, { dir: string }>).map((p) => p.dir),
    ).toEqual([path.join(storage, "boards")]);
  });
  it("sends changed CodeBoard settings and the editor font to open boards", () => {
    change("codeboard.studyScope", ["nanovllm"]);
    change("editor.fontFamily", "Iosevka");
    expect(posted("host")).toEqual([
      { type: "host", host: { settings: expect.objectContaining({ studyScope: ["nanovllm"] }) } },
      { type: "host", host: { fontFamily: "Iosevka" } },
    ]);
  });
  it("follows codeboard.storageDir to another directory", async () => {
    const switched = new Promise<string>((r) => {
      const d = host.onDidSwitchStorage((s) => {
        d.dispose();
        r(s.dir());
      });
    });
    change("codeboard.storageDir", moved);
    expect(await switched).toBe(moved);
    expect(host.store.dir()).toBe(moved);
    expect(
      Object.values(global.get("codeboard.projects") as Record<string, { dir: string }>).map((p) => p.dir),
    ).toContain(moved);
  });
  it("stops reacting once disposed", () => {
    host.dispose();
    const before = posted("host").length;
    change("editor.fontFamily", "Menlo");
    expect(posted("host")).toHaveLength(before);
  });
});

describe("scratch files and git", () => {
  // a worktree's .git is a file pointing into the main repo; info/exclude lives in the shared git dir
  it("are excluded in the repo's shared info/exclude, also from a worktree, once", async () => {
    const repo = tempRepo("scratch-exclude", { "a.py": "x = 1\n" });
    const wt = path.join(tmp, "wt");
    git(repo, "worktree", "add", "-q", wt);
    fs.mkdirSync(path.join(wt, "pkg"));
    await excludeScratch(path.join(wt, "pkg"));
    await excludeScratch(repo);
    const exclude = fs.readFileSync(path.join(repo, ".git", "info", "exclude"), "utf8");
    expect(exclude.split("\n").filter((l) => l === ".codeboard-scratch-*")).toHaveLength(1);
    fs.writeFileSync(path.join(wt, "pkg", scratchName("c1", "python")), "");
    expect(git(wt, "status", "--porcelain")).toBe("");
    fs.rmSync(repo, { recursive: true, force: true });
  });
  it("leave a directory outside any repo alone", async () => {
    await expect(excludeScratch(tmp)).resolves.toBeUndefined();
  });
});
