// 分析结果和白板模型都用到的小东西。白板界面也会引入这里，所以不放 tree-sitter。

/** 每行的标记：空行、整行注释、docstring（宿主为每段算好，白板按它隐藏行） */
export const F_BLANK = 1, F_COMMENT = 2, F_DOCSTRING = 4;

/** Call 上的变量：a = 调用处，b = 被调函数里的名字（名字不同才有）；ret = 返回值被谁接住 */
export type Var = { a: string; b?: string; ret?: boolean; custom?: boolean };
export const varKey = (v: Var) => `${v.ret ? "→" : ""}${v.a}|${v.b ?? ""}`;

/** 一个取值：name → value；opts = 可能的几个值（让人选一个，其余是灰色分支），from = 取值从哪来（SWITCH_RANKS(num_ranks)） */
export type BoundVal = { name: string; value: string; opts?: string[]; from?: string };
/** 一个备选：别的实现（path + line + qual，path 是宿主给的显示路径）或别的一组取值（vals）。lib = 在 library 里（不在 Study Scope，⌥ 才展开） */
export type CallAlt = { label: string; detail?: string; path?: string; line?: number; qual?: string; lib?: string; vals?: BoundVal[] };

export const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
