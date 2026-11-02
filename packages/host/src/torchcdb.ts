// The build's generated ATen folder, found through the compile_commands.json clangd uses.
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { slicer } from "./sched";
import type { HostContext } from "./context";

/**
 * 构建生成的 ATen 目录，从 clangd 用的 compile_commands.json 找：clangd 的 --compile-commands-dir 指的目录，
 * 没有就是 <root>、<root>/build、<root>/build/* 里第一个有它的。它的条目写着编译的是哪个生成的 Ufunc*.cpp，
 * 所以文件是源码根目录下的一份副本时（PyTorch 的 setup.py 会拷一份过去）也能找到真正的目录
 */
export async function genDirOf(cx: HostContext, root: string): Promise<string | undefined> {
  const args = cx.ws.settings.get<unknown>("clangd.arguments", root);
  const ws = cx.ws.files.rootOf(root) ?? root;
  const dirs: string[] = [];
  if (Array.isArray(args)) {
    const i = args.findIndex((a) => typeof a === "string" && /^--compile-commands-dir(=|$)/.test(a));
    const v = i < 0 ? undefined : /=/.test(args[i]) ? String(args[i]).replace(/^[^=]*=/, "") : args[i + 1];
    if (typeof v === "string" && v)
      dirs.push(path.resolve(ws, v.replace(/\$\{(workspaceFolder|workspaceRoot)\}/g, ws)));
  }
  dirs.push(root, path.join(root, "build"));
  try {
    for (const d of (await fs.readdir(path.join(root, "build"), { withFileTypes: true })).sort((a, b) =>
      a.name.localeCompare(b.name),
    ))
      if (d.isDirectory()) dirs.push(path.join(root, "build", d.name));
  } catch {
    /* no build/ */
  }
  for (const d of dirs) {
    const text = await cx.readText(path.join(d, "compile_commands.json"), false);
    if (text === null) continue;
    if (d === root) return await ufuncDir(text, d); // 源码根目录下的副本：只信它的条目
    return (await ufuncDir(text, d)) ?? editorPath(path.join(d, "aten", "src", "ATen")); // 没有编译 Ufunc 文件的条目：按通常的布局
  }
  return undefined;
}

/**
 * compile_commands.json 的文本里编译 Ufunc*.cpp / .cu 的条目所在的目录。只看 "file" 的值：command 也以同一个路径结尾
 * （… -c <file>），引号里还有转义的引号。文件可以有几十 MB：按行切成小段找，段之间让出（CMake 写的每个键值都在自己那一行）
 */
export async function ufuncDir(cdb: string, dir: string, p: path.PlatformPath = path): Promise<string | undefined> {
  const turn = slicer();
  for (let i = 0; i < cdb.length; ) {
    const nl = cdb.indexOf("\n", i + CDB_PIECE),
      j = nl < 0 ? cdb.length : nl + 1;
    for (const m of cdb.slice(i, j).matchAll(UFUNC_FILE_KEY)) {
      let file: unknown;
      try {
        file = JSON.parse(m[1]);
      } catch {
        continue;
      }
      const abs = typeof file === "string" ? p.resolve(dir, file) : "";
      if (UFUNC_PATH.test(abs)) return editorPath(p.dirname(abs), p);
    }
    i = j;
    await turn();
  }
  return undefined;
}

/**
 * 路径写成编辑器文件事件里的样子，生成的文件才对得上（isGen 比较的是字符串）：Windows 上 VS Code 的盘符是小写的 c:，
 * 而 CMake 写进 compile_commands.json 的、设置里手写的是 C:
 */
const editorPath = (abs: string, p: path.PlatformPath = path) =>
  p === path.win32 ? abs.replace(/^[A-Z](?=:)/, (c) => c.toLowerCase()) : abs;
const UFUNC_PATH = /[\\/]aten[\\/]src[\\/]ATen[\\/]Ufunc\w*\.(cpp|cu)$/;
const CDB_PIECE = 1 << 20;
const UFUNC_FILE_KEY = /"file"\s*:\s*("(?:[^"\\]|\\.)*Ufunc\w*\.(?:cpp|cu)")/g;
