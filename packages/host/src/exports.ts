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
import type { Storage } from "./storage/boards";
import { git } from "./git";
import type { HostContext } from "./context";

/** 所有白板上的问题（共享卡上的只算一次） */
export async function allQuestions(store: Storage): Promise<QuestionItem[]> {
  await store.list();
  return collectQuestions(store.cached().map((e) => ({ ...e, group: store.groupOf(e.id) })));
}

const remoteOf = (cx: HostContext, root: string) => {
  let p = cx.remotes.get(root);
  if (!p) {
    p = git(root, ["remote", "get-url", "origin"]).then((s) => s?.trim() || undefined);
    cx.remotes.set(root, p);
  }
  return p;
};

/** 段的 GitHub 永久链接（仓库的 origin 是 GitHub 时；GitHub Code 段直接有） */
export async function permalinks(cx: HostContext, segs: Segment[]): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const s of segs.slice(0, 2000)) {
    let remote: string | undefined;
    if (s.src.kind === "repo") {
      const a = cx.sources.absOf(s);
      const r = a ? await cx.git.repoRootOf(a) : null;
      remote = r ? await remoteOf(cx, r) : undefined;
    }
    const u = segPermalink(s, () => remote);
    if (u) out[s.id] = u;
  }
  return out;
}

const SAFE_NAME = (n: string) => n.replace(/[\\/:*?"<>|]+/g, "-").trim() || "board";

/** 导出成文件：先问存到哪。HTML 的 cbres: 引用换成 data: URL（字体在 media/board 里，图片在存储目录的 assets/ 里） */
export async function exportFile(
  cx: HostContext,
  store: Storage,
  kind: "html" | "md",
  name: string,
  text: string,
): Promise<boolean> {
  const ui = cx.ws.ui;
  const ext = kind === "html" ? "html" : "md";
  const file = await ui.saveDialog({
    defaultPath: path.join(cx.root0() || process.env.HOME || "", `${SAFE_NAME(name)}.${ext}`),
    filters: kind === "html" ? { "HTML Snapshot": ["html"] } : { Markdown: ["md"] },
  });
  if (!file) return false;
  const out = kind === "html" ? await inlineFor(cx.mediaDir, store, text) : text;
  await fs.writeFile(file, out);
  cx.log("info", `export: wrote ${kind} ${out.length} bytes`);
  void ui.info(`Exported ${path.basename(file)}`, "Reveal").then((r) => (r ? ui.revealInOS(file) : undefined));
  return true;
}

/** mediaDir = the board's media folder (HostContext.mediaDir). 只读这两个目录里的文件（路径里有 .. 的一律不读） */
function inlineFor(mediaDir: string, store: Storage, html: string): Promise<string> {
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
