// LaTeX 的 \( … \)（行内）和 \[ … \]（块）公式：聊天应用、论文、ChatGPT 的回答常这样写（usage feedback #54）。只在粘贴时认：
// 存下来的 Markdown 里 \[ 是转义的 [，打字、读文件时照旧
/** t 里一个公式记号的开头：\( \) \[ \]，前面的 \ 是偶数个（\\[ 是转义的 \ 加 [） */
const DELIM = /(?<!\\)((?:\\\\)*)\\([[\]()])/g;
export type BracketMath = { from: number; to: number; latex: string; display: boolean };

/** 记号的位置（\ 的位置）和是哪个字 */
export function bracketDelims(t: string): { at: number; c: string }[] {
  return [...t.matchAll(DELIM)].map((m) => ({ at: m.index! + m[1].length, c: m[2] }));
}

/**
 * 成对的 \( … \)、\[ … \]（from..to 是连记号在内的范围）。ok(k)：第 k 个记号（bracketDelims 的顺序）能不能当记号用（代码里的不能）。
 * 里面不能是空的，不能有 $（写成 $…$ 会断开）、空行（没配上的 \( 不吞掉后面几段），\( … \) 里不能有反引号（配到代码里去了）
 */
export function pairBrackets(t: string, ok: (k: number) => boolean = () => true): BracketMath[] {
  const ds = bracketDelims(t), out: BracketMath[] = [];
  for (let k = 0; k < ds.length; k++) {
    const d = ds[k];
    if ((d.c !== "(" && d.c !== "[") || !ok(k)) continue;
    const close = d.c === "(" ? ")" : "]";
    const e = ds.findIndex((x, j) => j > k && x.c === close && ok(j));
    if (e < 0) continue;
    const body = t.slice(d.at + 2, ds[e].at), latex = body.trim();
    if (!latex || body.includes("$") || /\n[ \t]*\n/.test(body) || (d.c === "(" && body.includes("`"))) continue;
    // 中间夹着别的记号：外面这个没配上，从里面那个接着找
    if (ds.slice(k + 1, e).some((x, j) => ok(k + 1 + j) && (x.c === "(" || x.c === "["))) continue;
    out.push({ from: d.at, to: ds[e].at + 2, latex, display: d.c === "[" });
    k = e;
  }
  return out;
}

/** 配上的换成 $…$、$$…$$（\[ … \] 里的原样留着换行和空白：单独几行的读成公式块） */
export function dollarBrackets(t: string, ok?: (k: number) => boolean): string {
  let out = "", last = 0;
  for (const p of pairBrackets(t, ok)) { out += t.slice(last, p.from) + (p.display ? `$$${t.slice(p.from + 2, p.to - 2)}$$` : `$${p.latex}$`); last = p.to; }
  return out + t.slice(last);
}
