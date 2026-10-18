// 宿主用：没有语言服务时按名字找被调函数，同名的多个定义按接收者排序；⌘K 的名字匹配打分。

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

const wordStart = (s: string, k: number) => k === 0 || /[._/\s-]/.test(s[k - 1]) || (s[k] >= "A" && s[k] <= "Z" && !(s[k - 1] >= "A" && s[k - 1] <= "Z"));

/** 子串匹配打分：越靠前越高，在词首再加分，越短越高；不包含返回 -1 */
export function substr(q: string, s: string): number {
  if (!q) return 0;
  const k = s.toLowerCase().indexOf(q.toLowerCase());
  return k < 0 ? -1 : 100 - k + (wordStart(s, k) ? 50 : 0) - s.length * 0.1;
}

/**
 * ⌘K 的模糊匹配：先看子串；否则按子序列，但每个字都得紧接上一个字或在词首（"ca" → can_allocate、"bm" → BlockManager），
 * 散落在中间的字不算（"step" 配不上 main）。子序列的分总比子串低；不匹配返回 -1
 */
export function fuzzy(q: string, s: string): number {
  const sub = substr(q, s);
  if (sub >= 0 || !q) return sub;
  const ql = q.toLowerCase(), sl = s.toLowerCase();
  let i = 0, score = 0, last = -2;
  for (let k = 0; k < sl.length && i < ql.length; k++) {
    if (sl[k] !== ql[i]) continue;
    const next = last === k - 1, start = wordStart(s, k);
    if (!next && !start) continue;
    score += next ? 3 : 2;
    last = k;
    i++;
  }
  return i === ql.length ? score - s.length * 0.1 : -1;
}
