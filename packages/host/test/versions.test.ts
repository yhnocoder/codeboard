// New versions of a card's code: only code after the pinned commit counts, and a commit that only moves the code re-pins the card
import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import type { CodeCard } from "@codeboard/core";
import { staleFor, staleSegments } from "../src/versions";
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

  it("moves the card to the new lines with the new commit as its pin when a commit only moves the code", async () => {
    // It used to keep the old pin with the new commit's line numbers, so the header and permalinks named other code
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
