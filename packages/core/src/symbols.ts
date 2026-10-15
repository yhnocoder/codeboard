// 不依赖语言服务器的符号解析：Python 按缩进，C/C++/CUDA 按大括号。
// 有语言服务器时宿主会优先用它，这里是兜底，也是测试里用的确定性实现。

export type Sym = {
  name: string;
  qual: string; // 如 Scheduler.schedule
  kind: "def" | "class";
  start: number; // 1-based，含装饰器
  defLine: number; // def/class 所在行
  end: number; // 1-based，含
};

const indentOf = (s: string) => s.length - s.trimStart().length;

export function pythonSymbols(lines: string[]): Sym[] {
  const out: Sym[] = [];
  const stack: { indent: number; name: string }[] = [];
  lines.forEach((line, idx) => {
    const m = /^(\s*)(?:async\s+)?(def|class)\s+(\w+)/.exec(line);
    if (!m) return;
    const indent = m[1].length;
    while (stack.length && stack[stack.length - 1].indent >= indent) stack.pop();
    const qual = [...stack.map((s) => s.name), m[3]].join(".");
    let start = idx;
    while (start > 0 && /^\s*@/.test(lines[start - 1])) start--;
    let end = idx;
    let open = 0; // 签名跨多行时，括号没闭合前都算签名
    for (let j = idx; j < lines.length; j++) {
      const l = lines[j];
      // 空行和只有注释的行不决定代码块在哪结束（顶格写的注释也可能在函数里）
      const code = l.trim() !== "" && !l.trimStart().startsWith("#");
      if (j > idx && open <= 0 && code && indentOf(l) <= indent) break;
      for (const ch of l.replace(/#.*$/, "")) open += ch === "(" || ch === "[" ? 1 : ch === ")" || ch === "]" ? -1 : 0;
      if (code) end = j;
    }
    out.push({ name: m[3], qual, kind: m[2] as "def" | "class", start: start + 1, defLine: idx + 1, end: end + 1 });
    stack.push({ indent, name: m[3] });
  });
  return out;
}

/** C 系语言：找「标识符(…) {」形式的函数定义，按大括号配对找结尾 */
export function braceSymbols(lines: string[]): Sym[] {
  const out: Sym[] = [];
  const text = lines.join("\n");
  const re = /^[ \t]*(?:template\s*<[^>]*>\s*)?(?:[\w:<>,*&\s]+?\s+)?([A-Za-z_][\w:]*)\s*\([^;{}]*\)\s*(?:const\s*)?(?:noexcept\s*)?(?:->\s*[\w:<>]+\s*)?\{/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const name = m[1].split("::").pop()!;
    if (/^(if|for|while|switch|return|catch|sizeof)$/.test(name)) continue;
    const startLine = text.slice(0, m.index).split("\n").length;
    let depth = 0, i = m.index + m[0].length - 1, endIdx = text.length - 1;
    for (; i < text.length; i++) {
      if (text[i] === "{") depth++;
      else if (text[i] === "}" && --depth === 0) { endIdx = i; break; }
    }
    const endLine = text.slice(0, endIdx).split("\n").length;
    out.push({ name, qual: m[1], kind: "def", start: startLine, defLine: startLine, end: endLine });
  }
  return out;
}

export function symbolsFor(lang: string, lines: string[]): Sym[] {
  if (lang === "python") return pythonSymbols(lines);
  if (/^(c|cpp|cuda-cpp|cuda|objective-c|objective-cpp)$/.test(lang)) return braceSymbols(lines);
  return [];
}

/** 含有某一行的最内层符号 */
export function symbolAt(syms: Sym[], line: number): Sym | undefined {
  return syms.filter((s) => s.start <= line && line <= s.end).sort((a, b) => a.end - a.start - (b.end - b.start))[0];
}

const KEYWORDS = new Set("if for while elif return print and or not in is with assert lambda yield await super isinstance len range zip min max sum sorted list dict set tuple int float str bool type getattr setattr hasattr enumerate sizeof switch catch".split(" "));

/** 一行里看起来像函数调用的位置：标识符后面紧跟「(」，排除定义本身和关键字 */
export function findCalls(line: string): { start: number; end: number; name: string; recv?: string }[] {
  if (/^\s*(def|class)\s/.test(line)) return [];
  const out: { start: number; end: number; name: string; recv?: string }[] = [];
  const code = line.replace(/#.*$/, "");
  const re = /([A-Za-z_]\w*)\s*\(/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(code))) {
    const name = m[1];
    if (KEYWORDS.has(name)) continue;
    const before = code.slice(0, m.index);
    if (/["'][^"']*$/.test(before) && (before.match(/["']/g)?.length ?? 0) % 2 === 1) continue; // 在字符串里
    const rm = /([A-Za-z_]\w*)\s*\.\s*$/.exec(before);
    out.push({ start: m.index, end: m.index + name.length, name, recv: rm?.[1] });
  }
  // self.model_runner.call("run", ...) 这种按名字分发的调用，把字符串当成被调函数
  const d = /\.call\(\s*(["'])(\w+)\1/.exec(code);
  if (d) {
    const s = d.index + d[0].indexOf(d[2]);
    out.push({ start: s, end: s + d[2].length, name: d[2], recv: /(\w+)\s*\.call\(/.exec(code)?.[1] });
  }
  return out;
}

/** 按接收者名字给候选定义排序：self.scheduler.schedule() 优先 Scheduler.schedule */
export function rankByReceiver<T extends { qual: string }>(cands: T[], recv?: string): T[] {
  if (!recv) return cands;
  const r = recv.replace(/_/g, "").toLowerCase();
  const score = (s: T) => {
    const cls = s.qual.split(".").slice(-2, -1)[0]?.toLowerCase() ?? "";
    return cls && (cls.includes(r) || r.includes(cls)) ? 1 : 0;
  };
  return [...cands].sort((a, b) => score(b) - score(a));
}
