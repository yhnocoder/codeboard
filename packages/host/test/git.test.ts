import * as fs from "node:fs";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { git as sh, tempRepo } from "./helpers";

// count the `git merge-base --is-ancestor` processes isAncestor starts
const runs = vi.hoisted(() => ({ n: 0 }));
vi.mock("node:child_process", async (orig) => {
  const cp = await orig<typeof import("node:child_process")>();
  return { ...cp, execFile: ((...a: Parameters<typeof cp.execFile>) => { if ((a[1] as string[] | undefined)?.includes("--is-ancestor")) runs.n++; return (cp.execFile as (...x: unknown[]) => unknown)(...a); }) as typeof cp.execFile };
});
const { isAncestor, repoRootOfDir, forgetRepos, upstreamRef } = await import("../src/git");

let R: string, C: string, c1: string, c2: string, later: string;
beforeAll(() => {
  R = tempRepo("anc", { "f.py": "x = 1\n" });
  c1 = sh(R, "rev-parse", "HEAD");
  fs.writeFileSync(path.join(R, "f.py"), "x = 2\n"); sh(R, "commit", "-qam", "two");
  c2 = sh(R, "rev-parse", "HEAD");
  // a clone that doesn't have the next commit yet
  C = fs.mkdtempSync("/tmp/codeboard-anc-clone-");
  sh(C, "clone", "-q", R, ".");
  fs.writeFileSync(path.join(R, "f.py"), "x = 3\n"); sh(R, "commit", "-qam", "three");
  later = sh(R, "rev-parse", "HEAD");
});
afterAll(() => { fs.rmSync(R, { recursive: true, force: true }); fs.rmSync(C, { recursive: true, force: true }); });

describe("isAncestor", () => {
  it("answers and remembers both yes and no for full shas", async () => {
    runs.n = 0;
    expect(await isAncestor(R, c1, c2)).toBe(true);
    expect(await isAncestor(R, c2, c1)).toBe(false);
    expect(await isAncestor(R, c1, c2)).toBe(true);
    expect(await isAncestor(R, c2, c1)).toBe(false);
    expect(runs.n).toBe(2);
  });
  it("asks again after git failed, and gets the real answer once the commit is fetched", async () => {
    runs.n = 0;
    expect(await isAncestor(C, c2, later)).toBe(false); // bad object in the clone: exit 128
    sh(C, "fetch", "-q", "origin");
    expect(await isAncestor(C, c2, later)).toBe(true);
    expect(runs.n).toBe(2);
  });
  it("doesn't remember answers for abbreviated commits", async () => {
    runs.n = 0;
    expect(await isAncestor(R, c1.slice(0, 7), c2)).toBe(true);
    expect(await isAncestor(R, c1.slice(0, 7), c2)).toBe(true);
    expect(runs.n).toBe(2);
  });
});

// The repo lookups are remembered, but only answers: a folder that becomes a repo later (git init) is found without a reload, and
// after a git event (forgetRepos, watch.ts) a new origin is the upstream
describe("repo lookups", () => {
  it("finds a repo made after a lookup that found none", async () => {
    const d = fs.realpathSync(fs.mkdtempSync("/tmp/codeboard-noinit-"));
    try {
      expect(await repoRootOfDir(d)).toBeNull();
      sh(d, "init", "-q");
      expect(await repoRootOfDir(d)).toBe(d);
    } finally { fs.rmSync(d, { recursive: true, force: true }); }
  });
  it("takes a new origin as the upstream after a git event", async () => {
    const d = tempRepo("upstream", { "f.py": "x = 1\n" });
    try {
      expect(await upstreamRef(d)).toBe("main");
      sh(d, "update-ref", "refs/remotes/origin/dev", "HEAD");
      sh(d, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/dev");
      forgetRepos();
      expect(await upstreamRef(d)).toBe("origin/dev");
    } finally { fs.rmSync(d, { recursive: true, force: true }); }
  });
});
