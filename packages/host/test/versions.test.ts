import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import type { CodeCard } from "@codeboard/core";
import { staleFor, staleSegments } from "../src/versions";
import { forgetIgnored, isIgnored } from "../src/git";
import { watchVersions } from "../src/watch";
import type { BoardHost } from "../src/boards";
import { nodeFs } from "../src/nodefs";
import { Storage } from "@codeboard/core/storage";
import { useWorkspace } from "../src/ws";
import { nodeWorkspace } from "./node-workspace";
import { card, git, startTreeSitter, tempRepo } from "./helpers";

beforeAll(startTreeSitter);
let R: string;
afterEach(() => { fs.rmSync(R, { recursive: true, force: true }); });

describe("new version check", () => {
  it("shows no new version when an older commit is checked out, and one when a newer commit is", async () => {
    const src = (body: string) => ["def g(x):", `    return ${body}`, ""].join("\n");
    R = tempRepo("older", { "f.py": src("x") });
    const old = git(R, "rev-parse", "HEAD");
    fs.writeFileSync(path.join(R, "f.py"), src("x + 1"));
    git(R, "commit", "-qam", "pinned");
    useWorkspace(nodeWorkspace(R));
    const { card: c } = await card(path.join(R, "f.py"), "g");
    const stale = async (cc: CodeCard) => { const ss = staleSegments({ cards: [cc], sidenotes: [] }); return (await staleFor(ss.segs, ss.up))[cc.segments[0].id]?.state; };
    expect(await stale(c)).toBe("ok");
    git(R, "checkout", "-q", old);
    expect(await stale(c)).toBe("ok");
    git(R, "checkout", "-q", "main");
    fs.writeFileSync(path.join(R, "f.py"), src("x + 2"));
    git(R, "commit", "-qam", "newer");
    expect(await stale(c)).toBe("changed");
  });

  it("pins a card on a file git ignores (generated build/ code) by its content, not as uncommitted, and the card stays current", async () => {
    R = tempRepo("ignored", { ".gitignore": "build/\n", "f.py": "def f():\n    return 1\n" });
    const gen = path.join(R, "build", "gen.py");
    fs.mkdirSync(path.dirname(gen));
    fs.writeFileSync(gen, "def kernel(x):\n    return x\n");
    useWorkspace(nodeWorkspace(R));
    const { seg } = await card(gen, "kernel");
    expect(seg.version.kind).toBe("hash");
    expect((await staleFor([seg]))[seg.id]?.state).toBe("ok");
    const untracked = path.join(R, "new.py");
    fs.writeFileSync(untracked, "def g():\n    return 2\n");
    expect((await card(untracked, "g")).seg.version).toMatchObject({ kind: "git", uncommitted: true });
  });

  it("asks git whether a file is ignored once, until the ignore rules may have changed", async () => {
    R = tempRepo("ignore-cache", { ".gitignore": "build/\n" });
    expect(await isIgnored(R, "build/gen.py")).toBe(true);
    fs.writeFileSync(path.join(R, ".gitignore"), "");
    expect(await isIgnored(R, "build/gen.py")).toBe(true);
    forgetIgnored();
    expect(await isIgnored(R, "build/gen.py")).toBe(false);
  });

  it("asks git again once .gitignore or .git/info/exclude changed outside the editor", async () => {
    R = tempRepo("ignore-watch", { ".gitignore": "build/\n" });
    const W = nodeWorkspace(R);
    useWorkspace(W);
    const panels = { refreshStale: async () => {}, get: () => undefined, staleChanged: () => undefined } as unknown as BoardHost;
    const w = watchVersions(panels, new Storage(nodeFs, { dir: () => path.join(R, ".boards") }));
    try {
      await w.ready;
      expect(await isIgnored(R, "build/gen.py")).toBe(true);
      fs.writeFileSync(path.join(R, ".gitignore"), "");
      W.fire.change.fire(path.join(R, ".gitignore"));
      expect(await isIgnored(R, "build/gen.py")).toBe(false);
      fs.writeFileSync(path.join(R, ".git/info/exclude"), "build/\n");
      W.fire.change.fire(path.join(R, ".git/info/exclude"));
      expect(await isIgnored(R, "build/gen.py")).toBe(true);
    } finally { w.dispose(); }
  });

  it("moves the card to the new lines with the new commit as its pin when a commit only moves the code", async () => {
    const F = ["def can_allocate(x):", "    return x > 0", "", "", "def allocate(x):", "    y = x + 1", "    return y", ""];
    R = tempRepo("moved", { "blocks.py": F.join("\n") });
    const base = git(R, "rev-parse", "HEAD");
    useWorkspace(nodeWorkspace(R));
    const { seg } = await card(path.join(R, "blocks.py"), "allocate");
    expect({ start: seg.start, version: seg.version }).toEqual({ start: 5, version: { kind: "git", commit: base } });
    fs.writeFileSync(path.join(R, "blocks.py"), F.slice(4).join("\n"));
    git(R, "commit", "-qam", "drop can_allocate");
    const head = git(R, "rev-parse", "HEAD");
    const st = (await staleFor([seg]))[seg.id];
    expect(st).toMatchObject({ state: "moved", start: 1, end: 3, version: { kind: "git", commit: head } });
  });
});
