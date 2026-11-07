// ⌘K's search traces: each session the board reports is kept in the storage folder's .trace/ (out of git) with each root's
// commit, branch and uncommitted changes, and Export Search Traces… writes them all as one JSON file
import * as fs from "node:fs";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { SearchTrace } from "@codeboard/core";
import { Storage } from "../src/storage/boards";
import { nodeFs } from "../src/storage/nodefs";
import { HostContext } from "../src/context";
import { exportSearchTraces, TRACE_FORMAT, type KeptTrace } from "../src/searchtrace";
import { nodeWorkspace } from "./node-workspace";

const repo = fs.realpathSync(fs.mkdtempSync("/tmp/codeboard-trace-repo-"));
const dir = fs.realpathSync(fs.mkdtempSync("/tmp/codeboard-trace-store-"));
const out = path.join(dir, "out.json");
const git = (...a: string[]) => execFileSync("git", a, { cwd: repo, encoding: "utf8" }).trim();
const W = nodeWorkspace(repo);
W.ui.saveDialog = async () => out;
const store = new Storage(nodeFs, { dir: () => dir });
let cx: HostContext;

const trace = (id: string, q: string, extra: Partial<SearchTrace> = {}): SearchTrace => ({
  id,
  at: new Date(Date.UTC(2026, 10, 7, 14, Number(id.slice(1)))).toISOString(),
  ms: 2000,
  board: "b1",
  boardName: "Engine",
  mode: "all",
  queries: [
    {
      q,
      t: 300,
      hits: [
        {
          group: "meaning",
          rank: 1,
          kind: "card",
          ref: "b1:c1",
          label: "Block manager",
          detail: "This board",
          score: 0.71,
        },
      ],
      meaning: { model: "embeddinggemma" },
    },
  ],
  ...extra,
});

beforeAll(() => {
  git("init", "-q", "-b", "main");
  git("config", "user.email", "t@t");
  git("config", "user.name", "t");
  fs.writeFileSync(path.join(repo, "a.py"), "x = 1\n");
  git("add", ".");
  git("commit", "-qm", "one");
  cx = new HostContext(W);
});
afterAll(() => {
  cx.dispose();
  fs.rmSync(repo, { recursive: true, force: true });
  fs.rmSync(dir, { recursive: true, force: true });
});

const kept = (): KeptTrace[] =>
  fs
    .readFileSync(path.join(dir, ".trace", "search.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l));

describe("search traces", () => {
  it("keep each session with the commit it ran on, and the uncommitted changes when there are some", async () => {
    await cx.searchTraces.record(store, trace("t1", "显存回收"));
    fs.writeFileSync(path.join(repo, "a.py"), "x = 2\n");
    fs.writeFileSync(path.join(repo, "new.py"), "y = 1\n");
    await cx.searchTraces.record(
      store,
      trace("t2", "kv cache", { marks: [{ ref: "b1:c1", label: "Block manager", q: "kv cache", good: false }] }),
    );
    const [a, b] = kept();
    const head = git("rev-parse", "HEAD");
    expect(a.roots).toEqual([{ name: path.basename(repo), commit: head, branch: "main" }]);
    expect(b.roots[0].commit).toBe(head);
    expect(b.roots[0].dirty?.files.sort()).toEqual([" M a.py", "?? new.py"]);
    expect(b.roots[0].dirty?.n).toBe(2);
    expect(b.roots[0].dirty?.stat).toMatch(/1 file changed/);
    expect(b.marks?.[0].good).toBe(false);
    expect(fs.readFileSync(path.join(dir, ".trace", ".gitignore"), "utf8")).toBe("*\n");
  });

  it("hash what the new files say, not only their names", async () => {
    const before = kept()[1].roots[0].dirty?.hash;
    fs.writeFileSync(path.join(repo, "new.py"), "y = 2\n");
    fs.mkdirSync(path.join(repo, "newdir"));
    fs.writeFileSync(path.join(repo, "newdir", "z.py"), "z = 1\n");
    await cx.searchTraces.record(store, trace("t3", "kv cache"));
    const mid = kept()[2].roots[0].dirty?.hash;
    expect(mid).not.toBe(before);
    // a file in a new folder counts too (status lists only the folder)
    fs.writeFileSync(path.join(repo, "newdir", "z.py"), "z = 2\n");
    await cx.searchTraces.record(store, trace("t3", "kv cache"));
    expect(kept()[3].roots[0].dirty?.hash).not.toBe(mid);
  });

  it("export as one JSON file, oldest first; a line cut short is skipped and the next one still kept", async () => {
    fs.appendFileSync(path.join(dir, ".trace", "search.jsonl"), '{"id":"t4","at":"2026');
    await cx.searchTraces.record(store, trace("t5", "prefill"));
    expect(await exportSearchTraces(cx, store)).toBe(true);
    const j = JSON.parse(fs.readFileSync(out, "utf8"));
    expect(j.format).toBe(TRACE_FORMAT);
    expect(j.traces.map((t: KeptTrace) => [t.id, t.queries[0].q])).toEqual([
      ["t1", "显存回收"],
      ["t2", "kv cache"],
      ["t3", "kv cache"],
      ["t5", "prefill"],
    ]);
    expect(j.traces[0].queries[0].hits[0].score).toBe(0.71);
  });
});
