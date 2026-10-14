import { execFile } from "node:child_process";
import * as path from "node:path";

function git(cwd: string, args: string[]): Promise<string | null> {
  return new Promise((res) => execFile("git", args, { cwd, maxBuffer: 32 << 20 }, (err, out) => res(err ? null : out)));
}

const roots = new Map<string, Promise<string | null>>();

/** 文件所在的 git 仓库根目录（子模块里的文件返回子模块自己的根） */
export function repoRoot(file: string): Promise<string | null> {
  const dir = path.dirname(file);
  if (!roots.has(dir)) roots.set(dir, git(dir, ["rev-parse", "--show-toplevel"]).then((s) => s?.trim() || null));
  return roots.get(dir)!;
}

export type Rev = { commit: string | null; dirty: boolean };

/** 文件当前对应的 commit，以及工作区里有没有未提交的改动 */
export async function revOf(file: string): Promise<Rev> {
  const root = await repoRoot(file);
  if (!root) return { commit: null, dirty: false };
  const [head, st] = await Promise.all([
    git(root, ["rev-parse", "HEAD"]),
    git(root, ["status", "--porcelain", "--", path.relative(root, file)]),
  ]);
  const commit = head?.trim() || null;
  // 未跟踪的文件不算在任何 commit 里
  if (st?.startsWith("??")) return { commit: null, dirty: true };
  return { commit, dirty: !!st?.trim() };
}

export const short = (c: string | null) => (c ? c.slice(0, 7) : "未入库");
