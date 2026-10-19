// project / library code：工作区 + Study Scope 里的包是 project，其余是 library。
// 宿主只标出「工作区外」的包名（CallSpan.pkg、PeekDef.lib），Study Scope 由白板对照设置判断，改设置不用重算。
import * as path from "node:path";
import { importPkg, type FileAnalysis } from "@codeboard/core/analysis";
import type { Segment } from "@codeboard/core";
import { exists, inWorkspace, wsRoots } from "./ws";

const wsPkg = new Map<string, Promise<boolean>>();
export const resetScope = () => wsPkg.clear();

/** 顶层包名在不在工作区里：某个根下有 <pkg>/、<pkg>.py 或 src/<pkg>/ */
export function isWorkspacePkg(pkg: string): Promise<boolean> {
  let p = wsPkg.get(pkg);
  if (!p) {
    p = (async () => {
      for (const r of wsRoots()) {
        if (path.basename(r) === pkg) return true;
        for (const c of [path.join(r, pkg), path.join(r, `${pkg}.py`), path.join(r, "src", pkg)]) if (await exists(c)) return true;
      }
      return false;
    })();
    wsPkg.set(pkg, p);
  }
  return p;
}

const SITE = /[\\/](site-packages|dist-packages)[\\/]/;

/** 工作区外文件所属的顶层包：site-packages 下第一层；否则沿 __init__.py 往上找到最外层包；都不是就用文件名 */
export async function topPkgOf(abs: string): Promise<string> {
  const site = SITE.exec(abs);
  if (site) return abs.slice(site.index + site[0].length).split(/[\\/]/)[0].replace(/\.pyi?$/, "");
  let dir = path.dirname(abs), top = "";
  while (dir !== path.dirname(dir) && (await exists(path.join(dir, "__init__.py")))) { top = path.basename(dir); dir = path.dirname(dir); }
  return top || path.basename(abs).replace(/\.\w+$/, "");
}

/** 定义所在的文件是 library 吗：是的话返回包名 */
export async function libOf(abs: string): Promise<string | undefined> {
  return inWorkspace(abs) ? undefined : topPkgOf(abs);
}

/**
 * 段里每个调用的 library 包。import 进来的名字看 import 的顶层包；本地的、self.x、相对导入跟着段所在的文件走。
 * imports 取自段那个版本的整个文件（拿不到就用当前文件）。
 */
export async function callPkgs(seg: Segment, imports: FileAnalysis["imports"], abs: string | null): Promise<(c: { name: string; recv?: string }) => string | undefined> {
  if (seg.src.kind === "free" || seg.src.kind === "github") return () => undefined;
  const own = seg.src.kind === "external" && abs ? await topPkgOf(abs) : undefined;
  const lib = new Map<string, boolean>();
  for (const im of imports) {
    const p = importPkg({ imports: [im] }, { name: im.name });
    if (p && !lib.has(p)) lib.set(p, !(await isWorkspacePkg(p)));
  }
  return (c) => {
    const p = importPkg({ imports }, c);
    if (p) return lib.get(p) ? p : undefined;
    return own;
  };
}
