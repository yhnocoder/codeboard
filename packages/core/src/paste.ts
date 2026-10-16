// 粘贴到画布：按剪贴板内容决定建什么卡；GitHub 代码链接解析；语言猜测。

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
  | { kind: "note" };

const URL_RE = /^https?:\/\/\S+$/;

/** 纯文本剪贴板内容建什么卡（工作区代码、图片由宿主 / 白板单独判断） */
export function classifyPaste(text: string): PasteKind {
  const t = text.trim();
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

/** 像不像代码；像的话猜语言（python / cpp / cuda-cpp，Triton、TileLang 归 python 但单独标出） */
export function guessLang(text: string): string | null {
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  if (!lines.length) return null;
  const score = { py: 0, c: 0, cu: 0 };
  for (const l of lines) {
    const s = l.trim();
    if (/^(def|class|import|from|return|if|elif|for|while|with|async|await|yield|raise|try|except|@)\b/.test(s) || /:\s*(#.*)?$/.test(s)) score.py++;
    if (/\b(self|None|True|False|lambda)\b/.test(s) || /^\w+(\s*,\s*\w+)*\s*=\s*\S/.test(s)) score.py += 0.5;
    if (/[;{}]\s*(\/\/.*)?$/.test(s) || /^#(include|define|pragma|if|endif)/.test(s) || /\b(std::|int|void|auto|const|template|struct|return)\b.*[;{]/.test(s)) score.c++;
    if (/__global__|__device__|__shared__|threadIdx|blockIdx|<<<|cudaMalloc|__syncthreads/.test(s)) score.cu += 2;
    if (/\b(tl|T)\.\w+\(|program_id|@triton\.jit|tilelang/.test(s)) score.py += 1.5;
  }
  const n = lines.length;
  const best = Math.max(score.py, score.c + score.cu);
  // 一半以上的行有代码特征才算代码
  if (best < Math.max(1, n * 0.4)) {
    // 单行赋值 / 调用也算
    if (n > 2 || !/[=()[\]]/.test(text) || /[一-鿿]/.test(text)) return null;
  }
  if (score.cu > 0) return "cuda-cpp";
  if (score.c > score.py) return "cpp";
  return "python";
}

/** Python 文件里更细的方言，用来给 Free code 的语言下拉默认值 */
export function pythonDialect(text: string): "triton" | "tilelang" | "python" {
  if (/import\s+triton|@triton\.jit|\btl\.(load|store|program_id|arange)/.test(text)) return "triton";
  if (/import\s+tilelang|\bT\.(Kernel|Tensor|alloc_|copy|gemm)/.test(text)) return "tilelang";
  return "python";
}

/** 语言下拉：显示名 ↔ VS Code languageId */
export const LANGS: { id: string; label: string }[] = [
  { id: "python", label: "Python" },
  { id: "triton", label: "Triton" },
  { id: "tilelang", label: "TileLang" },
  { id: "cuda-cpp", label: "CUDA" },
  { id: "cpp", label: "C++" },
];
export const langLabel = (id: string) => LANGS.find((l) => l.id === id)?.label ?? (id === "c" ? "C" : id);
