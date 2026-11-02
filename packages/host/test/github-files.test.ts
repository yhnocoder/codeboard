import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { emptyBoard, type CodeCard } from "@codeboard/core";
import { Storage } from "../src/storage/boards";
import { nodeFs } from "../src/storage/nodefs";
import { ghQuery, workspaceGithubFiles } from "../src/github";
import { nodeWorkspace, type TestWorkspace } from "./node-workspace";
import { startTreeSitter } from "./helpers";
import { HostContext } from "../src/context";

let cx: HostContext;

const C1 = "a".repeat(40),
  C2 = "b".repeat(40),
  C3 = "c".repeat(40);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "codeboard-ghfiles-"));
const cache = path.join(tmp, "github");

/** a workspace with its own state and board folder; the GitHub cache is shared */
function workspaceAt(name: string) {
  const w = nodeWorkspace(),
    state = new Map<string, unknown>();
  w.storage = {
    ...w.storage,
    get: <T>(k: string) => state.get(k) as T,
    set: async (k, v) => {
      state.set(k, v);
    },
  };
  return { w, store: new Storage(nodeFs, { dir: () => path.join(tmp, name) }) };
}
const cached = (owner: string, name: string, commit: string, rel: string, ref: string) => {
  const dir = path.join(cache, owner, name, commit);
  fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
  fs.writeFileSync(path.join(dir, rel), "# hi\n");
  fs.writeFileSync(path.join(dir, ".codeboard-ref"), ref);
};

/** A host on w; every host shares the GitHub cache */
const hostOn = (w: TestWorkspace) => {
  const h = new HostContext(w);
  h.sources.init(cache);
  return h;
};

describe("GitHub Files per workspace", () => {
  const A = workspaceAt("a"),
    B = workspaceAt("b");
  beforeAll(async () => {
    await startTreeSitter();
    cached("yhnocoder", "tongtu", C1, "CLAUDE.md", "main");
    cached("owner", "repo", C2, "src/x.md", "v1");
    cached("owner", "repo", C2, "src/y.md", "v1");
    cached("owner", "repo", C3, "src/x.md", "fix");
  });
  afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

  it("lists a file only in the workspace that opened it", async () => {
    let fired = 0;
    cx = hostOn(A.w);
    const sub = cx.githubFiles.onDidOpen(() => fired++);
    expect(await workspaceGithubFiles(cx, A.store)).toEqual([]);
    const q = { op: "file", owner: "yhnocoder", name: "tongtu", commit: C1, ref: "main", path: "CLAUDE.md" } as const;
    await Promise.all([ghQuery(cx, q), ghQuery(cx, q)]);
    sub.dispose();
    expect(fired).toBe(1);
    expect(await workspaceGithubFiles(cx, A.store)).toEqual([
      {
        owner: "yhnocoder",
        name: "tongtu",
        commit: C1,
        ref: "main",
        files: [
          {
            abs: path.join(cx.sources.githubFileDir("yhnocoder", "tongtu", C1), "CLAUDE.md"),
            rel: "CLAUDE.md",
            cards: 0,
          },
        ],
      },
    ]);
    cx = hostOn(B.w);
    expect(await workspaceGithubFiles(cx, B.store)).toEqual([]);
  });

  it("keeps remembering opened files after one write fails", async () => {
    const C = workspaceAt("c"),
      set = C.w.storage.set;
    let fail = true;
    C.w.storage = {
      ...C.w.storage,
      set: async (k, v) => {
        if (fail) {
          fail = false;
          throw new Error("disk full");
        }
        await set(k, v);
      },
    };
    cx = hostOn(C.w);
    const q = { op: "file", owner: "yhnocoder", name: "tongtu", commit: C1, ref: "main", path: "CLAUDE.md" } as const;
    await expect(ghQuery(cx, q)).rejects.toThrow("disk full");
    await ghQuery(cx, q);
    expect((await workspaceGithubFiles(cx, C.store)).map((r) => r.files.map((f) => f.rel))).toEqual([["CLAUDE.md"]]);
  });

  it("lists files that the workspace's boards have cards for, with the card count", async () => {
    cx = hostOn(B.w);
    const b = emptyBoard("b1", "B");
    const seg = (rel: string, commit = C2, ref = "v1") => ({
      src: { kind: "github", owner: "owner", name: "repo", ref },
      path: rel,
      version: { kind: "git", commit },
    });
    const code = (id: string, c: object) => ({ kind: "code", id, ...c }) as unknown as CodeCard;
    b.cards.push(
      code("c1", { segments: [seg("src/x.md")] }),
      // two sections of one file count the card once; the second file comes from a later segment
      code("c2", { segments: [seg("src/x.md"), seg("src/x.md"), seg("src/y.md")] }),
      // a PR Variant that is not shown keeps its file listed
      code("c3", {
        segments: [seg("src/y.md")],
        variants: [
          { id: "up", name: "upstream", from: { kind: "upstream" } },
          {
            id: "v",
            name: "#7",
            from: { kind: "pr", owner: "owner", name: "repo", num: 7 },
            segs: [seg("src/x.md", C3, "fix")],
          },
        ],
      }),
    );
    await B.store.save(b);
    const rs = await workspaceGithubFiles(cx, B.store);
    expect(rs).toHaveLength(2);
    expect(rs.find((r) => r.commit === C2)).toMatchObject({
      ref: "v1",
      files: [
        { rel: "src/x.md", cards: 2 },
        { rel: "src/y.md", cards: 2 },
      ],
    });
    expect(rs.find((r) => r.commit === C3)).toMatchObject({ ref: "fix", files: [{ rel: "src/x.md", cards: 1 }] });
  });
});
