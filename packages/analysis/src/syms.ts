// The shapes of an analysis result (symbols, calls, a whole file) and lookups on them; the analysis itself is in index.ts

export type Param = { name: string; kind: "self" | "pos" | "kw" | "star" | "dstar" };

export type Sym = {
  name: string;
  qual: string; // Scheduler.schedule；C++ 里是 ns::Cls::f
  kind: "def" | "class";
  start: number; // 1-based，含装饰器 / template
  defLine: number; // def / class 所在行
  end: number; // 1-based，含
  sig: string; // 一行签名：def schedule(self) -> tuple[list[Sequence], bool]
  params: Param[];
  parent?: string; // 所在类的 qual
  doc?: string; // docstring（去掉引号、公共缩进）
};

export type Arg = { text: string; name?: string; kw?: string; star?: boolean };

export type CallSite = {
  line: number; // 1-based
  col: number; // 被调名字的起始列（0-based，UTF-16）
  end: number;
  name: string;
  recv?: string; // self.scheduler.schedule() 的 self.scheduler
  loop: boolean; // 在同一函数的 for / while / 推导式里
  args: Arg[];
  assigned?: string[]; // 返回值被谁接住：seqs, is_prefill = …
  dispatch?: string; // call("run", …) 这种按字符串转发：记下字符串，但不当成调用 run
  launch?: "grid" | "<<<"; // kernel 启动：Triton 的 kernel[grid](…)、CUDA 的 kernel<<<…>>>(…)
};

export type FileAnalysis = {
  lang: string;
  symbols: Sym[];
  /** 每行的标记（下标 = 行号 - 1）：F_BLANK / F_COMMENT（整行是注释）/ F_DOCSTRING */
  flags: number[];
  /** 行尾注释：行号 → 注释开始的列 */
  trailing: Record<number, number>;
  calls: CallSite[];
  /** Python 的 if __name__ == "__main__": 块 */
  mainBlocks: { start: number; end: number }[];
  /** 模块 docstring */
  doc?: string;
  /** import 绑定的名字：import torch.multiprocessing as mp → { name: "mp", module: "torch.multiprocessing" }；相对导入 module 以 . 开头 */
  imports: { name: string; module: string; line: number; from?: true }[]; // from = from X import name（name 不一定是模块）
};

/** 含有某一行的最内层符号 */
export function symbolAt(syms: Sym[], line: number, kind?: Sym["kind"]): Sym | undefined {
  return syms
    .filter((s) => s.start <= line && line <= s.end && (!kind || s.kind === kind))
    .sort((a, b) => a.end - a.start - (b.end - b.start))[0];
}
