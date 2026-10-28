export type GithubRef = { owner: string; name: string; ref: string; path: string; start?: number; end?: number };

/** https://github.com/o/r/blob/<ref>/<path>#L25-L34（ref 里带 / 的分支名由宿主再用 API 校正） */
export function parseGithubUrl(url: string): GithubRef | null {
  const m = /^https?:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/(?:blob|tree)\/([^/]+)\/([^#?]+)(?:\?[^#]*)?(?:#L(\d+)(?:C\d+)?(?:-L(\d+)(?:C\d+)?)?)?$/.exec(url.trim());
  if (m) {
    const start = m[5] ? +m[5] : undefined;
    return { owner: m[1], name: m[2].replace(/\.git$/, ""), ref: m[3], path: decodeURIComponent(m[4]), start, end: m[6] ? +m[6] : start };
  }
  const raw = /^https?:\/\/raw\.githubusercontent\.com\/([\w.-]+)\/([\w.-]+)\/([^/]+)\/([^#?]+)$/.exec(url.trim());
  if (raw) return { owner: raw[1], name: raw[2], ref: raw[3], path: decodeURIComponent(raw[4]) };
  return null;
}

// 文档类文件的 blob 链接（README.md 之类）还是当网页书签；代码文件、或带 #L 行号的 → GitHub Code 卡
const DOC_EXT = /\.(md|markdown|rst|txt|ipynb|pdf|png|jpe?g|gif|svg|webp|html?)$/i;
function isGithubCode(url: string, g: GithubRef) {
  if (g.start) return true;
  return /^https?:\/\/(github\.com\/[^/]+\/[^/]+\/blob\/|raw\.githubusercontent\.com\/)/.test(url) && !DOC_EXT.test(g.path);
}

/** From GitHub… 面板的输入：owner/repo、仓库网址、tree / blob 链接 */
export type RepoInput = { owner: string; name: string; ref?: string; path?: string; start?: number; end?: number };
export function parseRepoInput(text: string): RepoInput | null {
  const t = text.trim().replace(/^git@github\.com:/, "https://github.com/");
  const g = parseGithubUrl(/^https?:/.test(t) ? t : `https://${t}`);
  if (g) return { owner: g.owner, name: g.name, ref: g.ref, path: g.path.replace(/\/$/, "") || undefined, ...(g.start ? { start: g.start, end: g.end } : {}) };
  const m = /^(?:https?:\/\/)?(?:www\.)?(?:github\.com\/)?([\w.-]+)\/([\w.-]+?)(?:\.git)?(?:\/(?:tree|commit)\/([^/#?]+)(?:\/([^#?]*))?)?\/?(?:[#?].*)?$/.exec(t);
  if (!m || m[1] === "github.com") return null;
  return { owner: m[1], name: m[2], ref: m[3], path: m[4] ? decodeURIComponent(m[4]).replace(/\/$/, "") || undefined : undefined };
}

export type PasteKind =
  | { kind: "github"; ref: GithubRef }
  | { kind: "web"; url: string }
  | { kind: "links"; urls: string[] } // 一次贴多个链接（每行一个）→ 一张 Link List
  | { kind: "code"; lang: string }
  | { kind: "note" }
  | { kind: "svg" }; // 一整份 SVG（设计工具的 Copy as SVG、编辑器里复制的 .svg 文件内容）→ Image 卡

const URL_RE = /^https?:\/\/\S+$/;

/** 纯文本剪贴板内容建什么卡（工作区代码、图片由宿主 / 白板单独判断） */
export function classifyPaste(text: string): PasteKind {
  const t = text.trim();
  if (isSvgMarkup(t)) return { kind: "svg" };
  if (URL_RE.test(t)) {
    const g = parseGithubUrl(t);
    if (g && isGithubCode(t, g)) return { kind: "github", ref: g };
    return { kind: "web", url: t };
  }
  const ls = t.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (ls.length > 1 && ls.every((l) => URL_RE.test(l))) return { kind: "links", urls: [...new Set(ls)] };
  const lang = guessLang(t);
  return lang ? { kind: "code", lang } : { kind: "note" };
}

// 和 @yhnocoder/markdown 编辑器里粘贴 SVG 的判断一样（那个包不依赖 core）
const SVG_DOC = /^\uFEFF?\s*(?:<\?xml[^>]*\?>\s*)?(?:(?:<!--[\s\S]*?-->|<!DOCTYPE\s+svg\b(?:[^>[]|\[[\s\S]*?\])*>)\s*)*<svg(?=[\s/>])(?:[^>]*\/>|[\s\S]*<\/svg>)\s*$/;
/** 整段文字是一份 SVG（从开头的 <svg> 到结尾） */
export const isSvgMarkup = (text: string) => SVG_DOC.test(text);

/** 像不像代码；像的话猜语言：python / shellscript，或花括号家族里的 c / cpp / cuda-cpp / javascript / typescript / rust / go
 *  （Triton、TileLang 归 python，由 pythonDialect 单独标出）。按行打分：花括号、分号结尾这类家族共有的特征记在 c 里，
 *  算出是这一家之后，再按各语言自己的特征（std::、fn、func、=>、: number …）分给具体的语言 */
export function guessLang(text: string): string | null {
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  if (!lines.length) return null;
  const score = { py: 0, c: 0, cu: 0, sh: 0 };
  const fam = { cpp: 0, c: 0, javascript: 0, typescript: 0, rust: 0, go: 0 };
  for (const l of lines) {
    const s = l.trim();
    const braced = /[;{}]\s*(\/\/.*)?$/.test(s);
    if (/^(def|class|import|from|return|if|elif|for|while|with|async|await|yield|raise|try|except|@)\b/.test(s) && !braced || /:\s*(#.*)?$/.test(s)) score.py++;
    if (/\b(self|None|True|False|lambda|elif)\b/.test(s) || /^\w+(\s*,\s*\w+)*\s*=\s*\S/.test(s) && !braced) score.py += 0.5;
    const cLike = braced || /^#(include|define|pragma|if|endif)/.test(s) || /\b(std::|int|void|auto|const|template|struct|return)\b.*[;{]/.test(s);
    const fam0 = Object.values(fam).reduce((a, b) => a + b, 0);
    if (/__global__|__device__|__shared__|threadIdx|blockIdx|<<<|cudaMalloc|cudaMemcpy|__syncthreads/.test(s)) score.cu += 2;
    if (/\b(tl|T)\.\w+\(|program_id|@triton\.jit|tilelang/.test(s)) score.py += 1.5;
    if (!braced && (/^(#!.*\b(ba|z)?sh\b|\$ \S)/.test(s) || /^(sudo|apt(-get)?|brew|pip3?|npm|npx|yarn|git|curl|wget|cd|ls|mkdir|rm|cp|mv|chmod|export|echo|source|conda|docker|make|nvcc)\s+[\w./~$"'-]/.test(s))) score.sh++;
    if (/^(fi|done|esac)$|(^|;\s*)(then|do)$|\$\{\w+\}|\$\w+/.test(s) && !braced) score.sh += 0.5;
    if (/std::|\btemplate\s*<|\bnamespace\b|\bclass\s+\w+\s*(:\s*public|\{|$)|\b(cout|cin|nullptr|constexpr|typename)\b|^(public|private|protected):|#include\s*<(iostream|vector|string|memory|map|unordered_map|algorithm|utility|functional|thread)>|\bauto\s+\w+\s*=|\w::\w+\(/.test(s)) fam.cpp++;
    if (/#include\s*<\w+\.h>|\b(printf|scanf|malloc|calloc|free|memcpy|memset|sizeof)\s*\(|\btypedef\s+struct\b|\bstruct\s+\w+\s*\*|^(static\s+)?(void|int|char|float|double|long|unsigned|size_t)\b[\w\s*]*\(|\b(int|float|double|char|unsigned|long)\s*\*?\s+\w+\s*[=;[,)]/.test(s)) fam.c++;
    if (/\bfunction\b|=>|\b(let|var)\s+[\w$]+\s*=|\bconst\s+([\w$]+\s*=|[{[])|console\.\w+\(|require\(|module\.exports|\bdocument\.|\bexport\s+(default|const|function|class)\b|^import\s.*\sfrom\s+['"]|===|!==/.test(s)) fam.javascript++;
    if (/\binterface\s+\w+|\btype\s+\w+(<[^>]*>)?\s*=|:\s*(string|number|boolean|any|unknown|never)\b|\bas\s+const\b|\breadonly\s+\w+|\)\s*:\s*\w+(<[^>]*>)?(\[\])?\s*(=>|\{)/.test(s)) fam.typescript++;
    if (/\bfn\s+\w+|\blet\s+mut\b|\bimpl\b|^(pub|mod|use)\s+[\w:{]|\w+!\(|&mut\b|::new\(|\b(Vec|Option|Result|Box)<|\b(Some|Ok|Err)\(/.test(s)) fam.rust++;
    if (/^package\s+\w+$|\bfunc\s+(\([^)]*\)\s*)?\w+\(|:=|\bfmt\.\w+\(|\bgo\s+func\b|\bchan\b|\bdefer\b|^import\s+\(/.test(s)) fam.go++;
    // 不靠分号、花括号的行（Go、JS 不写分号）有某一家自己的特征，也算花括号家族的代码行
    if (cLike || Object.values(fam).reduce((a, b) => a + b, 0) > fam0) score.c++;
  }
  const n = lines.length;
  const best = Math.max(score.py, score.c + score.cu, score.sh);
  // 一半以上的行有代码特征才算代码
  if (best < Math.max(1, n * 0.4)) {
    // 单行赋值 / 调用也算
    if (n > 2 || !/[=()[\]]/.test(text) || /[一-鿿]/.test(text)) return null;
  }
  if (score.sh > score.py && score.sh > score.c + score.cu) return "shellscript";
  if (score.cu > 0) return "cuda-cpp";
  if (score.c <= score.py) return "python";
  // TS 是 JS 加类型：TS 的特征一出现就算 TS。C++ 的写法大多也是 C 的，所以 C++ 的特征一出现就算 C++
  const ranked: [string, number][] = [
    ["rust", fam.rust], ["go", fam.go], ["typescript", fam.typescript && fam.typescript + fam.javascript], ["javascript", fam.javascript], ["cpp", fam.cpp && fam.cpp + fam.c], ["c", fam.c],
  ];
  const top = ranked.reduce((a, b) => (b[1] > a[1] ? b : a));
  return top[1] > 0 ? top[0] : "cpp";
}

/** Python 文件里更细的方言，用来给 Free code 的语言下拉默认值 */
export function pythonDialect(text: string): "triton" | "tilelang" | "python" {
  if (/import\s+triton|@triton\.jit|\btl\.(load|store|program_id|arange)/.test(text)) return "triton";
  if (/import\s+tilelang|\bT\.(Kernel|Tensor|alloc_|copy|gemm)/.test(text)) return "tilelang";
  return "python";
}

