// startHost wires a host from a Workspace and a HostEnv alone (what the VS Code extension and a Node sidecar both call): commands,
// views, settings broadcasts, following the storage directory and the workspace folders, the asset cleanup, cached definitions
// dropped on code changes, the board list sent again on new versions, the version watcher, and dispose that unhooks all of it
import * as fs from "node:fs";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Emitter, type HostToBoard } from "@codeboard/core";
import type { Storage } from "../src/storage/boards";
import type { HostEnv } from "../src/env";
import { startHost, type Host } from "../src/start";
import { GitCache } from "../src/git";
import { excludeScratch, scratchName } from "../src/scratchnames";
import type { HostContext } from "../src/context";
import { nodeWorkspace } from "./node-workspace";
import { git, stubView, tempRepo, MEDIA } from "./helpers";

// the asset cleanup runs a minute after a storage directory opens: what is scheduled for which directory, and what is cancelled
const sweeps = vi.hoisted(() => ({ scheduled: [] as string[], cancelled: [] as string[] }));
vi.mock("../src/assetsweep", async (orig) => ({
  ...(await orig<typeof import("../src/assetsweep")>()),
  scheduleAssetSweep: (_cx: HostContext, store: Storage) => {
    const dir = store.dir();
    sweeps.scheduled.push(dir);
    return () => void sweeps.cancelled.push(dir);
  },
}));

// the host's context, to reach its definition cache
const made = vi.hoisted(() => ({ cx: undefined as HostContext | undefined }));
vi.mock("../src/context", async (orig) => {
  const m = await orig<typeof import("../src/context")>();
  class Recorded extends m.HostContext {
    constructor(...a: ConstructorParameters<typeof m.HostContext>) {
      super(...a);
      made.cx = this;
    }
  }
  return { ...m, HostContext: Recorded };
});

const tmp = fs.mkdtempSync("/tmp/codeboard-start-");
const root = path.join(tmp, "ws"),
  storage = path.join(tmp, "storage"),
  moved = path.join(tmp, "moved");
fs.mkdirSync(root);
const W = nodeWorkspace(root);
let roots = [root];
const rootsChanged = new Emitter<void>();
const gitChanged = new Emitter<void>();
let gitListeners = 0;
W.files = {
  ...W.files,
  roots: () => roots,
  onDidChangeRoots: rootsChanged.event,
  onDidChangeGit: (fn) => {
    gitListeners++;
    const d = gitChanged.event(fn);
    return {
      dispose: () => {
        gitListeners--;
        d.dispose();
      },
    };
  },
};
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
  host = startHost(W, env, { mediaDir: MEDIA });
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
  it("schedules the asset cleanup for the storage directory", () => {
    expect(sweeps.scheduled).toEqual([path.join(storage, "boards")]);
  });
  it("sends changed CodeBoard settings and the editor font to open boards", () => {
    change("codeboard.studyScope", ["nanovllm"]);
    change("editor.fontFamily", "Iosevka");
    expect(posted("host")).toEqual([
      { type: "host", host: { settings: expect.objectContaining({ studyScope: ["nanovllm"] }) } },
      { type: "host", host: { fontFamily: "Iosevka" } },
    ]);
  });
  it("starts the version watcher once ready", () => {
    expect(gitListeners).toBe(1);
  });
  it("forgets cached definitions when code is edited, saved, created, deleted or renamed", async () => {
    const f = path.join(root, "defs.py");
    fs.writeFileSync(f, "x = 1\n");
    let asks = 0;
    const defs = () =>
      made.cx!.defs.shared(f, 1, 0, async () => {
        asks++;
        return [{ abs: f, line: 1, col: 0 }];
      });
    await defs();
    await defs();
    expect(asks).toBe(1);
    const events = [
      () => W.fire.edit.fire(f),
      () => W.fire.save.fire(f),
      () => W.fire.create.fire([f]),
      () => W.fire.delete.fire([f]),
      () => W.fire.rename.fire([{ from: f, to: f }]),
    ];
    for (const [i, ev] of events.entries()) {
      ev();
      await defs();
      expect(asks).toBe(i + 2);
    }
  });
  it("sends the board list again when a board's count of new versions changes", async () => {
    const id = host.hub.all()[0].id;
    const before = posted("boards").length;
    host.hub.staleChanged(id, 2);
    await vi.waitFor(() => expect(posted("boards").length).toBeGreaterThan(before));
    const last = posted("boards").at(-1) as Extract<HostToBoard, { type: "boards" }>;
    expect(last.boards.find((b) => b.id === id)?.stale).toBe(2);
  });
  it("follows the workspace folders to another folder's .codeboard", async () => {
    const other = path.join(tmp, "other");
    fs.mkdirSync(path.join(other, ".codeboard"), { recursive: true });
    const switched = new Promise<string>((r) => {
      const d = host.onDidSwitchStorage((s) => {
        d.dispose();
        r(s.dir());
      });
    });
    roots = [other];
    rootsChanged.fire();
    expect(await switched).toBe(path.join(other, ".codeboard"));
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
    // the cleanup is scheduled again for the directory switched to, the one scheduled before is cancelled
    expect(sweeps.scheduled.at(-1)).toBe(moved);
    expect(sweeps.cancelled.at(-1)).toBe(sweeps.scheduled.at(-2));
    expect(
      Object.values(global.get("codeboard.projects") as Record<string, { dir: string }>).map((p) => p.dir),
    ).toContain(moved);
  });
  it("stops reacting once disposed", () => {
    host.dispose();
    const before = posted("host").length;
    change("editor.fontFamily", "Menlo");
    expect(posted("host")).toHaveLength(before);
    expect(gitListeners).toBe(0);
    expect(sweeps.cancelled.at(-1)).toBe(moved);
  });
});

describe("scratch files and git", () => {
  // a worktree's .git is a file pointing into the main repo; info/exclude lives in the shared git dir
  it("are excluded in the repo's shared info/exclude, also from a worktree, once", async () => {
    const repo = tempRepo("scratch-exclude", { "a.py": "x = 1\n" });
    const wt = path.join(tmp, "wt");
    git(repo, "worktree", "add", "-q", wt);
    fs.mkdirSync(path.join(wt, "pkg"));
    const cache = new GitCache();
    await excludeScratch(cache, path.join(wt, "pkg"));
    await excludeScratch(cache, repo);
    const exclude = fs.readFileSync(path.join(repo, ".git", "info", "exclude"), "utf8");
    expect(exclude.split("\n").filter((l) => l === ".codeboard-scratch-*")).toHaveLength(1);
    fs.writeFileSync(path.join(wt, "pkg", scratchName("c1", "python")), "");
    expect(git(wt, "status", "--porcelain")).toBe("");
    fs.rmSync(repo, { recursive: true, force: true });
  });
  it("leave a directory outside any repo alone", async () => {
    await expect(excludeScratch(new GitCache(), tmp)).resolves.toBeUndefined();
  });
});
