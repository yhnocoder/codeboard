import * as fs from "node:fs";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { git as sh, tempRepo } from "./helpers";

// count the `git merge-base --is-ancestor` processes isAncestor starts, and the repo root lookups
const runs = vi.hoisted(() => ({ n: 0, top: 0 }));
vi.mock("node:child_process", async (orig) => {
  const cp = await orig<typeof import("node:child_process")>();
  return {
    ...cp,
    execFile: ((...a: Parameters<typeof cp.execFile>) => {
      if ((a[1] as string[] | undefined)?.includes("--is-ancestor")) runs.n++;
      if ((a[1] as string[] | undefined)?.includes("--show-toplevel")) runs.top++;
      return (cp.execFile as (...x: unknown[]) => unknown)(...a);
    }) as typeof cp.execFile,
  };
});
const { GitCache } = await import("../src/git");
const cache = new GitCache();

let R: string, C: string, c1: string, c2: string, later: string;
beforeAll(() => {
  R = tempRepo("anc", { "f.py": "x = 1\n" });
  c1 = sh(R, "rev-parse", "HEAD");
  fs.writeFileSync(path.join(R, "f.py"), "x = 2\n");
  sh(R, "commit", "-qam", "two");
  c2 = sh(R, "rev-parse", "HEAD");
  // a clone that doesn't have the next commit yet
  C = fs.mkdtempSync("/tmp/codeboard-anc-clone-");
  sh(C, "clone", "-q", R, ".");
  fs.writeFileSync(path.join(R, "f.py"), "x = 3\n");
  sh(R, "commit", "-qam", "three");
  later = sh(R, "rev-parse", "HEAD");
});
afterAll(() => {
  fs.rmSync(R, { recursive: true, force: true });
  fs.rmSync(C, { recursive: true, force: true });
});

describe("isAncestor", () => {
  it("answers and remembers both yes and no for full shas", async () => {
    runs.n = 0;
    expect(await cache.isAncestor(R, c1, c2)).toBe(true);
    expect(await cache.isAncestor(R, c2, c1)).toBe(false);
    expect(await cache.isAncestor(R, c1, c2)).toBe(true);
    expect(await cache.isAncestor(R, c2, c1)).toBe(false);
    expect(runs.n).toBe(2);
  });
  it("asks again after git failed, and gets the real answer once the commit is fetched", async () => {
    runs.n = 0;
    expect(await cache.isAncestor(C, c2, later)).toBe(false); // bad object in the clone: exit 128
    sh(C, "fetch", "-q", "origin");
    expect(await cache.isAncestor(C, c2, later)).toBe(true);
    expect(runs.n).toBe(2);
  });
  it("doesn't remember answers for abbreviated commits", async () => {
    runs.n = 0;
    expect(await cache.isAncestor(R, c1.slice(0, 7), c2)).toBe(true);
    expect(await cache.isAncestor(R, c1.slice(0, 7), c2)).toBe(true);
    expect(runs.n).toBe(2);
  });
});

// The repo lookups are remembered, "no repo" too, until a git event or a change of workspace folders (forgetRepos, watch.ts):
// a folder that becomes a repo later (git init) is found then, and a new origin is the upstream
describe("repo lookups", () => {
  it("asks git once for a folder that is no repo, and finds the repo made there after a git event", async () => {
    const d = fs.realpathSync(fs.mkdtempSync("/tmp/codeboard-noinit-"));
    try {
      runs.top = 0;
      expect(await cache.repoRootOfDir(d)).toBeNull();
      expect(await cache.repoRootOfDir(d)).toBeNull();
      expect(runs.top).toBe(1);
      sh(d, "init", "-q");
      cache.forgetRepos();
      expect(await cache.repoRootOfDir(d)).toBe(d);
    } finally {
      fs.rmSync(d, { recursive: true, force: true });
    }
  });
  it("doesn't remember a lookup that failed for another reason: a folder that isn't there yet is asked again", async () => {
    const d = path.join(fs.realpathSync(fs.mkdtempSync("/tmp/codeboard-gone-")), "repo");
    try {
      runs.top = 0;
      expect(await cache.repoRootOfDir(d)).toBeNull(); // no cwd: git never ran
      fs.mkdirSync(d);
      sh(d, "init", "-q");
      expect(await cache.repoRootOfDir(d)).toBe(d); // no git event in between
      expect(runs.top).toBe(2);
    } finally {
      fs.rmSync(path.dirname(d), { recursive: true, force: true });
    }
  });
  it("takes a new origin as the upstream after a git event", async () => {
    const d = tempRepo("upstream", { "f.py": "x = 1\n" });
    try {
      expect(await cache.upstreamRef(d)).toBe("main");
      sh(d, "update-ref", "refs/remotes/origin/dev", "HEAD");
      sh(d, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/dev");
      cache.forgetRepos();
      expect(await cache.upstreamRef(d)).toBe("origin/dev");
    } finally {
      fs.rmSync(d, { recursive: true, force: true });
    }
  });
});

// Scratch files are kept out of git status with a line in the repo's own info/exclude (local, never committed)
describe("excludeFromGit", () => {
  const PAT = ".cb-scratch-*";
  const exclude = (gitDir: string) => fs.readFileSync(path.join(gitDir, "info", "exclude"), "utf8");
  const count = (t: string) => t.split("\n").filter((l) => l === PAT).length;

  it("adds the line once, from a subfolder too", async () => {
    const d = tempRepo("exclude", { "sub/f.py": "x = 1\n" });
    try {
      await cache.excludeFromGit(path.join(d, "sub"), PAT, "scratch");
      cache.forgetRepos();
      await cache.excludeFromGit(d, PAT, "scratch");
      expect(count(exclude(path.join(d, ".git")))).toBe(1);
      expect(exclude(path.join(d, ".git"))).toContain("# scratch\n");
    } finally {
      fs.rmSync(d, { recursive: true, force: true });
    }
  });

  it("writes a worktree's line into the git directory the worktrees share", async () => {
    const d = tempRepo("exclude-main", { "f.py": "x = 1\n" });
    const w = `${d}-wt`;
    try {
      sh(d, "worktree", "add", "-q", "-b", "side", w);
      await cache.excludeFromGit(w, PAT, "scratch");
      expect(count(exclude(path.join(d, ".git")))).toBe(1);
    } finally {
      fs.rmSync(w, { recursive: true, force: true });
      fs.rmSync(d, { recursive: true, force: true });
    }
  });

  it("does nothing outside a repo, and adds the line once the folder became one and a git event came", async () => {
    const d = fs.realpathSync(fs.mkdtempSync("/tmp/codeboard-exclude-none-"));
    try {
      await cache.excludeFromGit(d, PAT, "scratch");
      sh(d, "init", "-q");
      await cache.excludeFromGit(d, PAT, "scratch");
      expect(
        fs.existsSync(path.join(d, ".git", "info", "exclude")) && count(exclude(path.join(d, ".git"))),
      ).toBeFalsy();
      cache.forgetRepos();
      await cache.excludeFromGit(d, PAT, "scratch");
      expect(count(exclude(path.join(d, ".git")))).toBe(1);
    } finally {
      fs.rmSync(d, { recursive: true, force: true });
    }
  });
});
