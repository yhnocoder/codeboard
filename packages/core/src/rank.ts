// 宿主用：没有语言服务时按名字找被调函数，同名的多个定义按接收者排序。

export type Cand = { qual: string; path: string; line: number };

const norm = (s: string) => s.replace(/_/g, "").toLowerCase();

/**
 * self.scheduler.schedule() → 类名像 Scheduler 的排前面；self.foo() → 当前类（selfClass）里的排前面；
 * 没有接收者 → 同一个文件里的排前面、模块级函数排前面。
 * 返回排好序的候选，以及「有没有唯一的最佳」。
 */
export function rankByReceiver<T extends Cand>(cands: T[], recv: string | undefined, here: { path: string; selfClass?: string }): { ranked: T[]; best?: T } {
  const score = (c: T) => {
    const parts = c.qual.split(/\.|::/);
    const cls = parts.length > 1 ? parts[parts.length - 2] : "";
    let s = 0;
    if (!recv) {
      if (!cls) s += 2;
      if (c.path === here.path) s += 1;
      return s;
    }
    const last = recv.split(".").pop()!.replace(/\(.*$/, "");
    if ((last === "self" || last === "cls") && recv.split(".").length === 1) {
      if (here.selfClass && cls === here.selfClass.split(/\.|::/).pop()) s += 4;
      if (c.path === here.path) s += 1;
      return s;
    }
    if (cls && norm(cls) === norm(last)) s += 4;
    else if (cls && (norm(cls).includes(norm(last)) || norm(last).includes(norm(cls)))) s += 3;
    // 模块别名：torch.foo → path 里有 torch
    else if (!cls && c.path.split("/").some((p) => norm(p.replace(/\.\w+$/, "")) === norm(last))) s += 2;
    if (c.path === here.path) s += 0.5;
    return s;
  };
  const ranked = cands.map((c) => ({ c, s: score(c) })).sort((a, b) => b.s - a.s || a.c.qual.localeCompare(b.c.qual));
  const best = ranked.length === 1 || (ranked.length > 1 && ranked[0].s > ranked[1].s && ranked[0].s >= 1) ? ranked[0].c : undefined;
  return { ranked: ranked.map((r) => r.c), best };
}

/** *.dist-info 目录名 → 包名和版本：torch-2.5.1.dist-info */
export function parseDistInfo(dir: string): { name: string; version: string } | null {
  const m = /^(.+?)-([^-]+?)\.(dist-info|egg-info)$/.exec(dir);
  return m ? { name: m[1], version: m[2] } : null;
}

/** git log --format=%H%x09%s%x09%as 的输出 */
export function parseGitLog(out: string): { commit: string; msg: string; date: string }[] {
  return out.split("\n").map((l) => l.split("\t")).filter((p) => /^[0-9a-f]{7,40}$/.test(p[0] ?? "")).map(([commit, msg, date]) => ({ commit, msg: msg ?? "", date: date ?? "" }));
}
