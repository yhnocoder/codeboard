// GITHUB FILES sidebar: downloads are cached once for every workspace, but each workspace lists only the GitHub files it opened
// itself or that its own boards' cards point at
import * as fs from "node:fs";
import * as os from "node:os";
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

const C1 = "a".repeat(40), C2 = "b".repeat(40), C3 = "c".repeat(40);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "codeboard-ghfiles-"));
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
    cached("owner", "repo", C2, "src/y.md", "v1");
    cached("owner", "repo", C3, "src/x.md", "fix");
  });
  afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

  it("lists a file only in the workspace that opened it", async () => {
    let fired = 0;
    const sub = onDidOpenGithubFile(() => fired++);
    useWorkspace(A.w);
    expect(await workspaceGithubFiles(A.store)).toEqual([]);
    const q = { op: "file", owner: "yhnocoder", name: "tongtu", commit: C1, ref: "main", path: "CLAUDE.md" } as const;
    await Promise.all([ghQuery(q), ghQuery(q)]);
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
    const seg = (rel: string, commit = C2, ref = "v1") => ({ src: { kind: "github", owner: "owner", name: "repo", ref }, path: rel, version: { kind: "git", commit } });
    const code = (id: string, c: object) => ({ kind: "code", id, ...c }) as unknown as CodeCard;
    b.cards.push(
      code("c1", { segments: [seg("src/x.md")] }),
      // two sections of one file count the card once; the second file comes from a later segment
      code("c2", { segments: [seg("src/x.md"), seg("src/x.md"), seg("src/y.md")] }),
      // a PR Variant that is not shown keeps its file listed
      code("c3", { segments: [seg("src/y.md")], variants: [{ id: "up", name: "upstream", from: { kind: "upstream" } }, { id: "v", name: "#7", from: { kind: "pr", owner: "owner", name: "repo", num: 7 }, segs: [seg("src/x.md", C3, "fix")] }] }),
    );
    await B.store.save(b);
    const rs = await workspaceGithubFiles(B.store);
    expect(rs).toHaveLength(2);
    expect(rs.find((r) => r.commit === C2)).toMatchObject({ ref: "v1", files: [{ rel: "src/x.md", cards: 2 }, { rel: "src/y.md", cards: 2 }] });
    expect(rs.find((r) => r.commit === C3)).toMatchObject({ ref: "fix", files: [{ rel: "src/x.md", cards: 1 }] });
  });
});
