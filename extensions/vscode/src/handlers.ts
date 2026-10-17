// 白板发来的消息：每种消息一个处理函数，带 req 的请求返回值就是回答（类型按 core 的 ReplyOf 检查；Panels 包成 reply）。
import * as path from "node:path";
import * as fs from "node:fs/promises";
import { findCard, fingerprint, isCode, locateSeg, mapLineTo, segOf, versionLabel, type AskType, type BoardToHost, type Commit, type DiffData, type ReplyOf, type Segment, type SegView } from "@codeboard/core";
import { analysisOf } from "./analysis";
import { commitInfo, headOf, logLines, repoRootOf, resolveRef, showFile } from "./git";
import { githubCard, ghQuery } from "./github";
import { webMeta } from "./web";
import { pasteCard } from "./paste";
import { writeSetting } from "./settings";
import { readPacks } from "./stickers";
import { log } from "./log";
import { copyDiagnostics, openStickerDir } from "./diagnostics";
import type { BoardHost, BoardPanel } from "./boards";
import { callVars, expand, peek } from "./resolve";
import { search, searchPick, entryPoints } from "./search";
import { prefetchCall } from "./prefetch";
import { absOf, currentVersionLabel, locOfFile, mapRepo, present, srcKey, srcLabel, versionText } from "./source";
import { boardSegments, makeSegment, workingPlace } from "./versions";
import { highlight, segView, viewsFor } from "./views";
import { fromHostPath, langOf, readText, splitLines, workspace, ws0 } from "./ws";

type Msg<T extends BoardToHost["type"]> = Extract<BoardToHost, { type: T }>;
/** 处理函数的返回值：要回答的请求是它的回答，其他的不管 */
type Out<T extends BoardToHost["type"]> = T extends AskType ? ReplyOf<T> : unknown;
type Handlers = { [T in BoardToHost["type"]]: (p: BoardPanel, m: Msg<T>) => Promise<Out<T>> | Out<T> };
export type Handler = (p: BoardPanel, m: BoardToHost) => Promise<unknown>;

export function makeHandler(panels: BoardHost): Handler {
  const store = panels.store;
  const h: Handlers = {
    ready: () => undefined, // Panels 自己处理
    save: async (p, m) => {
      if (p.board) m.board.id = p.board.id; // 存到这块面板打开的那个文件，不信白板发来的 id
      const renamed = p.board?.name !== m.board.name;
      p.board = m.board;
      await store.save(m.board);
      if (renamed) { p.view.title = m.board.name; void panels.pushBoards(); }
      return null;
    },
    selection: (p, m) => { p.selection = m; },
    open: (p, m) => openCard(p, m),
    openPath: (_p, m) => openAt(fromHostPath(m.path), m.line),
    openLink: (_p, m) => {
      // 白板文件里的链接只放行网页和邮件：file:// 之类会直接打开本机的程序
      const scheme = /^([^:/?#]+?):/.exec(m.url)?.[1] ?? "file";
      if (!/^(https?|mailto)$/.test(scheme)) { log("info", `openLink: blocked ${scheme}: link`); return; }
      void workspace().ui.openUrl(m.url);
    },
    expand: (_p, m) => expand(m),
    peek: (_p, m) => peek(m),
    prefetch: (_p, m) => prefetchCall(m),
    callVars: (_p, m) => callVars(m),
    search: (_p, m) => search(store, m.q, m.scope),
    searchPick: (_p, m) => searchPick(m.item),
    entryPoints: () => entryPoints(),
    diff: (_p, m) => diff(m.seg, m.against),
    commits: (_p, m) => commits(m.seg),
    switchCommit: (_p, m) => switchCommit(m.seg, m.commit),
    resolveRef: (p, m) => resolveTyped(p, m.text),
    paste: (_p, m) => pasteCard(m.text),
    github: (_p, m) => githubCard(m.url),
    saveAsset: (_p, m) => store.saveAsset(m.name, m.dataUrl),
    exportPng: (_p, m) => exportPng(m.dataUrl, m.name),
    views: (_p, m) => viewsFor(m.segs),
    checkVersions: (p) => p.refreshStale(),
    relocate: (p, m) => relocate(p, m.card),
    locateRepo: (p) => locateRepo(p),
    setSetting: (_p, m) => writeSetting(m.key, m.value),
    webMeta: (_p, m) => webMeta(store, m.url),
    gh: (_p, m) => ghQuery(m.q),
    stickerPacks: () => readPacks(),
    openStickerDir: () => openStickerDir(),
    copyDiagnostics: (p, m) => copyDiagnostics(p.board, m.board),
    log: (_p, m) => log(m.level, m.text),
    openBoard: async (_p, m) => {
      const np = await panels.show(m.id);
      if (np && m.card) np.post({ type: "reveal", card: m.card });
    },
    confirm: async (_p, m) => (await workspace().ui.warn(m.text, { modal: true, detail: m.detail }, m.ok)) === m.ok,
    pickFile: () => pickImage(),
  };
  return async (p, m) => (h[m.type] as ((p: BoardPanel, m: BoardToHost) => unknown) | undefined)?.(p, m); // 不认识的消息（更新的白板）不理
}

// ---------- 跳转 ----------

export const openAt = (abs: string, line?: number) => workspace().editor.open(abs, { line });

/** Open in Editor：钉的版本就是当前代码时开工作区文件，否则开那个 commit 的只读版本 */
export async function openSeg(seg: Segment, line?: number) {
  if (seg.src.kind === "free") throw new Error("Free code has no source file.");
  const ed = workspace().editor;
  const abs = absOf(seg);
  if (seg.src.kind === "github") {
    if (!abs) throw new Error("GitHub file is not cached.");
    return ed.open(abs, { line: line ?? seg.start, readonly: true });
  }
  if (!(await present(seg))) throw new Error(`Repo “${srcLabel(seg.src)}” not found. Use Locate Repo… to point to it.`);
  const wp = await workingPlace(seg);
  if (wp?.exact) {
    const l = line === undefined ? wp.start : wp.start + (line - seg.start);
    return ed.open(wp.abs, { line: l, end: line === undefined ? wp.end : l });
  }
  if (seg.version.kind === "git" && abs) {
    const root = await repoRootOf(abs);
    if (root && (await showFile(root, seg.version.commit, path.relative(root, abs).split(path.sep).join("/"))) !== null)
      return ed.openVersion({ root, commit: seg.version.commit, path: path.relative(root, abs).split(path.sep).join("/") }, line ?? seg.start);
  }
  if (wp) return ed.open(wp.abs, { line: mapLineTo(seg, line ?? seg.start, wp.lines.slice(wp.start - 1, wp.end), wp.start) });
  throw new Error(`Cannot open ${seg.path}.`);
}

async function openCard(p: BoardPanel, m: Msg<"open">) {
  let seg: Segment | undefined;
  const f = p.board && findCard(p.board, m.card);
  if (f && isCode(f.card)) seg = segOf(f.card, m.seg);
  if (!seg && p.board) {
    // Code sidenote：card 是 sidenote 的 id，或 seg 是它的段
    const n = p.board.sidenotes.find((s) => s.kind === "code" && (s.id === m.card || s.code.id === m.seg));
    if (n?.kind === "code") seg = n.code;
  }
  if (!seg) throw new Error("Card not found.");
  return openSeg(seg, m.line);
}

// ---------- 版本 ----------

/** 「新版本」diff：钉住的段 vs HEAD（against 可以是别的 commit / branch，或 "working" = 工作区） */
async function diff(seg: Segment, against?: string): Promise<DiffData> {
  const wt = against === "worktree" || against === "working";
  const name = seg.symbol?.qual ?? `${path.basename(seg.path)} ${seg.start}–${seg.end}`;
  const title = wt ? `Uncommitted Changes · ${name}` : `New Version · ${name}`;
  const left = { label: wt ? versionLabel(seg.version) : `Pinned ${versionLabel(seg.version)}`, path: seg.path, start: seg.start, text: seg.text, html: await highlight(seg.text, seg.lang, (await versionText(seg)) ?? undefined) };
  const abs = absOf(seg);
  const empty = (label: string): DiffData => ({ title, left, right: { label, path: seg.path, start: seg.start, text: [], html: [] }, canUpdate: false });
  if (!abs || seg.src.kind === "free" || seg.src.kind === "github") return empty("No newer version");
  let text: string | null = null, label = "", newVersion = seg.version, lastChange: string | undefined;
  const root = seg.version.kind === "git" ? await repoRootOf(abs) : null;
  const rel = root ? path.relative(root, abs).split(path.sep).join("/") : seg.path;
  if (wt || seg.version.kind !== "git" || seg.version.uncommitted) {
    text = await readText(abs);
    label = seg.version.kind === "git" ? "Working Tree" : `Installed ${await currentVersionLabel(abs, seg.version)}`;
    if (seg.version.kind === "git") newVersion = { kind: "git", commit: (root && (await headOf(root))) || seg.version.commit, uncommitted: true };
    else if (text !== null) newVersion = seg.version.kind === "pkg" ? { kind: "pkg", ...(splitPkg(await currentVersionLabel(abs, seg.version)) ?? seg.version) } : { kind: "hash", hash: fingerprint(text) };
  } else if (root) {
    const sha = against ? await resolveRef(root, against) : await headOf(root);
    if (!sha) throw new Error(`Unknown commit “${against}”.`);
    text = await showFile(root, sha, rel);
    label = `${against && against !== "HEAD" ? against : "HEAD"} ${sha.slice(0, 7)}`;
    newVersion = { kind: "git", commit: sha };
  }
  if (text === null) return empty(label || "Not found");
  const lines = splitLines(text);
  const at = locateSeg(seg, lines, analysisOf(seg.lang, text).symbols);
  if (!at || at === "many") return { ...empty(label), lastChange: at === "many" ? "Found in several places" : "Symbol not found (removed or renamed)" };
  const now = lines.slice(at.start - 1, at.end);
  if (root && newVersion.kind === "git" && !newVersion.uncommitted) {
    const log = await logLines(root, rel, at.start, at.end, newVersion.commit, 1);
    if (log[0]) lastChange = `Last changed in ${log[0].commit.slice(0, 7)} · ${log[0].msg} · ${log[0].date}`;
  }
  const newSeg: Segment = { ...seg, start: at.start, end: at.end, text: now, version: newVersion };
  return {
    title, left,
    right: { label, path: seg.path, start: at.start, text: now, html: await highlight(now, seg.lang, text) },
    lastChange, canUpdate: true, newSeg, newView: await segView(newSeg),
  };
}

const splitPkg = (s: string) => { const m = /^(\S+) (\S+)$/.exec(s); return m ? { name: m[1], version: m[2] } : null; };

/** commit 下拉：改过这个符号的 commit（git log -L） */
async function commits(seg: Segment): Promise<Commit[]> {
  if (seg.version.kind !== "git" || seg.src.kind === "free" || seg.src.kind === "github") return [];
  const abs = absOf(seg);
  const root = abs && (await repoRootOf(abs));
  if (!abs || !root) return [];
  const rel = path.relative(root, abs).split(path.sep).join("/");
  const head = await headOf(root);
  // 按 HEAD 里的位置算；HEAD 里找不到就按钉住的版本算
  let rev = head ?? seg.version.commit, start = seg.start, end = seg.end;
  const ht = head && (await showFile(root, head, rel));
  const at = ht ? locateSeg(seg, splitLines(ht), analysisOf(seg.lang, ht).symbols) : null;
  if (at && at !== "many") ({ start, end } = at); else rev = seg.version.commit;
  const log = await logLines(root, rel, start, end, rev, 40);
  const pinned = seg.version.commit;
  if (!log.some((c) => c.commit.startsWith(pinned))) {
    const info = await commitInfo(root, pinned);
    if (info) log.push(info);
  }
  // HEAD 没改这个函数（比如是个合并提交）时 git log -L 不列它；总放在最上面，切到旧版本后还能切回来
  if (head && !log.some((c) => c.commit === head)) {
    const info = await commitInfo(root, head);
    if (info) log.unshift(info);
  }
  return log.map((c) => ({ commit: c.commit, msg: c.msg, date: c.date, head: !!head && c.commit === head }));
}

/** 段换到另一个 commit：在那个版本里重新找符号 / 内容 */
async function switchCommit(seg: Segment, commit: string): Promise<{ seg: Segment; view: SegView }> {
  const abs = absOf(seg);
  const root = abs && (await repoRootOf(abs));
  if (!abs || !root) throw new Error("This code is not in a git repo.");
  const sha = await resolveRef(root, commit);
  if (!sha) throw new Error(`Unknown commit “${commit}”.`);
  const rel = path.relative(root, abs).split(path.sep).join("/");
  const text = await showFile(root, sha, rel);
  if (text === null) throw new Error(`${rel} does not exist in ${sha.slice(0, 7)}.`);
  const lines = splitLines(text);
  const at = locateSeg(seg, lines, analysisOf(seg.lang, text).symbols);
  if (!at) throw new Error(`${seg.symbol?.qual ?? "This code"} is not in ${sha.slice(0, 7)}.`);
  if (at === "many") throw new Error(`Found in several places in ${sha.slice(0, 7)}.`);
  const ns: Segment = { ...seg, start: at.start, end: at.end, text: lines.slice(at.start - 1, at.end), version: { kind: "git", commit: sha } };
  return { seg: ns, view: await segView(ns) };
}

/** 手输 commit / branch / tag：在白板用到的仓库里依次试 */
async function resolveTyped(p: BoardPanel, text: string): Promise<Commit | null> {
  const roots: string[] = [];
  for (const s of p.board ? boardSegments(p.board) : []) {
    const a = absOf(s);
    const r = a && s.version.kind === "git" && (await repoRootOf(a));
    if (r && !roots.includes(r)) roots.push(r);
  }
  if (ws0()) { const r = await repoRootOf(path.join(ws0(), "x")); if (r && !roots.includes(r)) roots.push(r); }
  for (const r of roots) {
    const sha = await resolveRef(r, text.trim());
    if (!sha) continue;
    const info = await commitInfo(r, sha);
    return { commit: sha, msg: info?.msg ?? "", date: info?.date ?? "", head: sha === (await headOf(r)) };
  }
  return null;
}

/** Focus 模式的只读源码浮窗：整个文件（那个版本） */

// ---------- 其他 ----------

async function exportPng(dataUrl: string, name: string) {
  const ui = workspace().ui;
  const file = await ui.saveDialog({ defaultPath: path.join(ws0() || process.env.HOME || "", `${name || "board"}.png`), filters: { "PNG Image": ["png"] } });
  if (!file) return;
  await fs.writeFile(file, Buffer.from(dataUrl.replace(/^data:[^,]*,/, ""), "base64"));
  void ui.info(`Exported ${path.basename(file)}`, "Reveal").then((r) => (r ? ui.revealInOS(file) : undefined));
}

async function pickImage(): Promise<string | null> {
  const file = await workspace().ui.openDialog({ filters: { Images: ["png", "jpg", "jpeg", "gif", "svg", "webp"] }, label: "Add Image" });
  if (!file) return null;
  const buf = await fs.readFile(file);
  const ext = path.extname(file).slice(1).toLowerCase();
  const mime = ext === "svg" ? "image/svg+xml" : ext === "jpg" ? "image/jpeg" : `image/${ext}`;
  return `data:${mime};base64,${buf.toString("base64")}`;
}

/** 符号找不到：在当前文件的符号里选新位置，段换成 HEAD 里的新符号 */
async function relocate(p: BoardPanel, cardId: string) {
  const f = p.board && findCard(p.board, cardId);
  if (!f || !isCode(f.card)) throw new Error("Card not found.");
  const seg = f.card.segments.find((s) => s.symbol) ?? f.card.segments[0];
  const abs = absOf(seg);
  const text = abs && (await readText(abs));
  if (!abs || text === null || text === undefined) throw new Error(`${seg.path} not found.`);
  const lang = langOf(abs);
  const syms = analysisOf(lang, text).symbols;
  const pick = await workspace().ui.pick(
    syms.map((s) => ({ label: `${s.kind === "class" ? "$(symbol-class)" : "$(symbol-method)"} ${s.qual}`, description: `${path.basename(abs)}:${s.defLine}`, s })),
    { placeHolder: `Where is ${seg.symbol?.qual ?? "this code"} now?`, matchOnDescription: true },
  );
  if (!pick) return;
  const lines = splitLines(text);
  const ns = await makeSegment(await locOfFile(abs), lines, pick.s.start, pick.s.end, { lang, symbol: { qual: pick.s.qual, kind: pick.s.kind === "class" ? "class" : "function" } });
  ns.id = seg.id;
  p.post({ type: "replaceSegment", card: cardId, seg: ns, view: await segView(ns) });
  p.post({ type: "stale", stale: { ...p.stale, [seg.id]: { state: "ok" } } });
}

/** 仓库找不到：选一个文件夹当它的根 */
async function locateRepo(p: BoardPanel) {
  if (!p.board) return;
  const miss = new Map<string, Segment>();
  for (const s of boardSegments(p.board)) if (s.src.kind !== "free" && s.src.kind !== "github" && !(await present(s))) miss.set(srcKey(s.src), s);
  if (!miss.size) { p.toast("All repos are available."); return; }
  let key = [...miss.keys()][0];
  if (miss.size > 1) {
    const r = await workspace().ui.pick([...miss.entries()].map(([k, s]) => ({ label: srcLabel(s.src), description: k, k })), { placeHolder: "Which repo do you want to locate?" });
    if (!r) return;
    key = r.k;
  }
  const seg = miss.get(key)!;
  const dir = await workspace().ui.openDialog({ folders: true, label: "Use This Folder", title: `Locate “${srcLabel(seg.src)}”` });
  if (!dir) return;
  const exists = await fs.stat(path.join(dir, seg.path)).then(() => true, () => false);
  if (!exists) {
    const go = await workspace().ui.warn(`${seg.path} is not in this folder.`, { modal: true }, "Use Anyway");
    if (go !== "Use Anyway") return;
  }
  await mapRepo(key, dir);
  await p.reload();
}


