import * as path from "node:path";
import * as fs from "node:fs/promises";
import {
  collectQuestions,
  inlineSnapshot,
  mimeOf,
  segPermalink,
  type QuestionItem,
  type Segment,
} from "@codeboard/core";
import type { Storage } from "@codeboard/core/storage";
import { git, repoRootOf } from "./git";
import { absOf } from "./source";
import { log } from "./log";
import { workspace, ws0 } from "./ws";

/** 插件的 media/board 目录（白板的 CSS、字体）：激活时设好；测试里按源码位置找 */
let mediaDir = path.resolve(__dirname, "../media/board");
export const setMediaDir = (d: string) => {
  mediaDir = d;
};

/** 所有白板上的问题（共享卡上的只算一次） */
export async function allQuestions(store: Storage): Promise<QuestionItem[]> {
  await store.list();
  return collectQuestions(store.cached().map((e) => ({ ...e, group: store.groupOf(e.id) })));
}

const remotes = new Map<string, Promise<string | undefined>>();
const remoteOf = (root: string) => {
  let p = remotes.get(root);
  if (!p) {
    p = git(root, ["remote", "get-url", "origin"]).then((s) => s?.trim() || undefined);
    remotes.set(root, p);
  }
  return p;
};

/** 段的 GitHub 永久链接（仓库的 origin 是 GitHub 时；GitHub Code 段直接有） */
export async function permalinks(segs: Segment[]): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const s of segs.slice(0, 2000)) {
    let remote: string | undefined;
    if (s.src.kind === "repo") {
      const a = absOf(s);
      const r = a ? await repoRootOf(a) : null;
      remote = r ? await remoteOf(r) : undefined;
    }
    const u = segPermalink(s, () => remote);
    if (u) out[s.id] = u;
  }
  return out;
}

const SAFE_NAME = (n: string) => n.replace(/[\\/:*?"<>|]+/g, "-").trim() || "board";

/** 导出成文件：先问存到哪。HTML 的 cbres: 引用换成 data: URL（字体在 media/board 里，图片在存储目录的 assets/ 里） */
export async function exportFile(store: Storage, kind: "html" | "md", name: string, text: string): Promise<boolean> {
  const ui = workspace().ui;
  const ext = kind === "html" ? "html" : "md";
  const file = await ui.saveDialog({
    defaultPath: path.join(ws0() || process.env.HOME || "", `${SAFE_NAME(name)}.${ext}`),
    filters: kind === "html" ? { "HTML Snapshot": ["html"] } : { Markdown: ["md"] },
  });
  if (!file) return false;
  const out = kind === "html" ? await inlineFor(store, text) : text;
  await fs.writeFile(file, out);
  log("info", `export: wrote ${kind} ${out.length} bytes`);
  void ui.info(`Exported ${path.basename(file)}`, "Reveal").then((r) => (r ? ui.revealInOS(file) : undefined));
  return true;
}

/** 只读这两个目录里的文件（路径里有 .. 的一律不读） */
export function inlineFor(store: Storage, html: string): Promise<string> {
  return inlineSnapshot(html, async (kind, rel) => {
    const base = kind === "media" ? mediaDir : store.assetsDir();
    const abs = path.resolve(base, rel);
    if (path.relative(base, abs).startsWith("..")) return null;
    try {
      return { mime: mimeOf(abs), base64: (await fs.readFile(abs)).toString("base64") };
    } catch {
      return null;
    }
  });
}
