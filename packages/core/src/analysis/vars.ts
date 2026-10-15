// Call link 上的变量候选：调用处的实参 ↔ 被调函数的形参，加上返回值被谁接住。
// 默认一个都不加，只给候选。推不出来（*args 转手、按字符串转发、不知道被调的是谁）时为空。
import type { Var } from "../model";
import type { CallSite, Sym } from "./index";

const short = (s: string, n = 28) => (s.length > n ? s.slice(0, n - 1) + "…" : s);

export function varCandidates(call: CallSite, callee: Sym | undefined): Var[] {
  if (!callee || call.dispatch) return [];
  const out: Var[] = [];
  const params = callee.params.filter((p) => p.kind !== "self");
  // obj.method(x) 调到一个没有 self 的模块函数时（比如 torch.foo），参数照常对位
  let i = 0;
  for (const a of call.args) {
    if (a.star) break; // *args 之后对不上了
    if (a.kw) continue;
    const p = params[i];
    if (!p || p.kind === "star" || p.kind === "dstar" || p.kind === "kw") break;
    out.push(pair(a.name ?? short(a.text), p.name));
    i++;
  }
  for (const a of call.args) {
    if (!a.kw) continue;
    const p = params.find((q) => q.name === a.kw);
    if (!p && !params.some((q) => q.kind === "dstar")) continue;
    out.push(pair(a.name ?? short(a.text), a.kw));
  }
  if (call.assigned?.length) out.push({ a: call.assigned.join(", "), ret: true });
  // 去重（同一个名字出现两次）
  const seen = new Set<string>();
  return out.filter((v) => { const k = varKey(v); if (seen.has(k)) return false; seen.add(k); return true; });
}

const pair = (a: string, b: string): Var => (a === b ? { a } : { a, b });

export const varKey = (v: Var) => `${v.ret ? "→" : ""}${v.a}|${v.b ?? ""}`;

/** 线上显示的文字：名字相同只显示一个；不同显示 a → b；返回值 → logits */
export const varText = (v: Var) => (v.ret ? `→ ${v.a}` : v.b ? `${v.a} → ${v.b}` : v.a);
