// GITHUB FILES sidebar: downloads are cached once for every workspace, but each workspace lists only the GitHub files it opened
// itself or that its own boards' cards point at
import * as fs from "node:fs";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { emptyBoard, type CodeCard } from "@codeboard/core";
import { Storage } from "@codeboard/core/storage";
import { nodeFs } from "../src/nodefs";
import { ghQuery, onDidOpenGithubFile, workspaceGithubFiles } from "../src/github";
import { githubFileDir, initSource } from "../src/source";
import { useWorkspace } from "../src/ws";
import { nodeWorkspace } from "./node-workspace";
import { startTreeSitter } from "./helpers";

const C1 = "a".repeat(40), C2 = "b".repeat(40);
const tmp = fs.mkdtempSync("/tmp/codeboard-ghfiles-");
const cache = path.join(tmp, "github");

/** a workspace with its own state and board folder; the GitHub cache is shared */
function workspaceAt(name: string) {
  const w = nodeWorkspace(), state = new Map<string, unknown>();
  w.storage = { ...w.storage, get: <T>(k: string) => state.get(k) as T, set: async (k, v) => { state.set(k, v); } };
  return { w, store: new Storage(nodeFs, { dir: () => path.join(tmp, name) }) };
}
const cached = (owner: string, name: string, commit: string, rel: string, ref: string) => {
  const dir = githubFileDir(owner, name, commit);
  fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
  fs.writeFileSync(path.join(dir, rel), "# hi\n");
  fs.writeFileSync(path.join(dir, ".codeboard-ref"), ref);
};

describe("GitHub Files per workspace", () => {
  const A = workspaceAt("a"), B = workspaceAt("b");
  beforeAll(async () => {
    await startTreeSitter();
    useWorkspace(A.w);
    initSource(cache);
    cached("yhnocoder", "tongtu", C1, "CLAUDE.md", "main");
    cached("owner", "repo", C2, "src/x.md", "v1");
  });
  afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

  it("lists a file only in the workspace that opened it", async () => {
    let fired = 0;
    const sub = onDidOpenGithubFile(() => fired++);
    useWorkspace(A.w);
    expect(await workspaceGithubFiles(A.store)).toEqual([]);
    await ghQuery({ op: "file", owner: "yhnocoder", name: "tongtu", commit: C1, ref: "main", path: "CLAUDE.md" });
    await ghQuery({ op: "file", owner: "yhnocoder", name: "tongtu", commit: C1, ref: "main", path: "CLAUDE.md" });
    sub.dispose();
    expect(fired).toBe(1);
    expect(await workspaceGithubFiles(A.store)).toEqual([{
      owner: "yhnocoder", name: "tongtu", commit: C1, ref: "main",
      files: [{ abs: path.join(githubFileDir("yhnocoder", "tongtu", C1), "CLAUDE.md"), rel: "CLAUDE.md", cards: 0 }],
    }]);
    useWorkspace(B.w);
    expect(await workspaceGithubFiles(B.store)).toEqual([]);
  });

  it("lists files that the workspace's boards have cards for, with the card count", async () => {
    useWorkspace(B.w);
    const b = emptyBoard("b1", "B");
    const seg = { src: { kind: "github", owner: "owner", name: "repo", ref: "v1" }, path: "src/x.md", version: { kind: "git", commit: C2 } };
    b.cards.push({ kind: "code", id: "c1", segments: [seg] } as unknown as CodeCard, { kind: "code", id: "c2", segments: [seg] } as unknown as CodeCard);
    await B.store.save(b);
    const [r] = await workspaceGithubFiles(B.store);
    expect(r).toMatchObject({ owner: "owner", name: "repo", commit: C2, ref: "v1", files: [{ rel: "src/x.md", cards: 2 }] });
  });
});
