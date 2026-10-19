// 存储用的最小文件系统适配器：宿主给 node:fs 的实现，测试用内存实现。路径拼接也交给它（Windows 的分隔符）。

export type DirEnt = { name: string; isFile: boolean; isDir: boolean };
export type FileStat = { mtimeMs: number; birthtimeMs: number; ctimeMs: number };

export interface Fs {
  /** 目录项（带类型）；目录不存在时抛错 */
  readdir(dir: string): Promise<DirEnt[]>;
  stat(p: string): Promise<FileStat>;
  readFile(p: string): Promise<string>;
  writeFile(p: string, data: string | Uint8Array): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  /** 删文件，不存在不报错 */
  rm(p: string): Promise<void>;
  /** 删空目录（里面还有东西时抛错） */
  rmdir(p: string): Promise<void>;
  /** 建目录（含上级），已有不报错 */
  mkdir(p: string): Promise<void>;
  join(...parts: string[]): string;
  /** base64 → 字节（和 node Buffer 一样宽松） */
  fromBase64(s: string): Uint8Array;
  /** sha1 的十六进制 */
  sha1(data: Uint8Array): string;
}

/** 文件名（不带目录） */
export const baseName = (p: string) => p.split(/[\\/]/).pop() ?? p;
/** 所在的目录（去掉最后一段） */
export const dirName = (p: string) => p.slice(0, Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\")));
/** 扩展名（含点；没有返回 ""），同 node path.extname */
export function extName(p: string) {
  const b = baseName(p);
  const i = b.lastIndexOf(".");
  return i <= 0 ? "" : b.slice(i);
}
