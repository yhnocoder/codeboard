// 白板发来的消息：带 req 的请求，处理函数的返回值就是回答（类型按 core 的 ReplyOf 检查；BoardHub 包成 reply）。
import * as path from "node:path";
import * as fs from "node:fs/promises";
import { BOARD_VERSION, COMPLETE_SYSTEM, cardPath, sniffImage, sniffSvg, cleanCompletion, spaceChatReply, loadBoard, subCardOf, wouldCycle, completePrompt, findCard, isCode, locateSeg, mapLineTo, segOf, versionLabel, type AskType, type BoardToHost, type Commit, type DiffData, type ReplyOf, type Segment, type SegView } from "@codeboard/core";
import { analysisOf } from "./analysis";
import { codeDoc, codeDocClose, lspComplete, lspHover, lspSignature } from "./codeedit";
import { commitInfo, headOf, logLines, repoRootOf, resolveRef, showFile, upstreamRef } from "./git";
import { githubCard, ghQuery } from "./github";
import { webMeta } from "./web";
import { tidy } from "@codeboard/core/tidy";
import { pasteCard } from "./paste";
import { writeSetting } from "./settings";
import { openStickerDir, readPacks } from "./stickers";
import { readAsset, readImageUri, saveNoteImage } from "./images";
import { log } from "./log";
import { copyDiagnostics } from "./diagnostics";
import type { BoardHost, BoardPanel } from "./boards";
import { callVars, dispatchAt, expand, peek } from "./resolve";
import { search, searchPick, entryPoints, searchName, genSource } from "./search";
import { pasteClip } from "@codeboard/core/storage";
import { pasteFar, recordClip } from "./transfer";
import { prefetchCall } from "./prefetch";
import { applyFlow, captureFlow } from "./runs";
import { prompts } from "./prompts";
import { allQuestions, exportFile, permalinks } from "./exports";
import { exportFlow } from "./bundle";
import { absOf, currentVersion, currentVersionLabel, locOfFile, mapRepo, present, srcKey, srcLabel, versionText, hasLocalFile } from "./source";
import { boardSegments, makeSegment, workingPlace } from "./versions";
import { addVariant, variantSources } from "./variants";
import { highlight, segView, viewsFor } from "./views";
import { fromHostPath, hostPath, langOf, readText, splitLines, workspace, ws0 } from "./ws";
import { lookupName } from "./nameindex";
import { aiInfo, imageAiJob } from "./imageai";

const SAFE_BOARD_ID = /^[\w-]{1,80}$/;

type Msg<T extends BoardToHost["type"]> = Extract<BoardToHost, { type: T }>;
type Out<T extends BoardToHost["type"]> = T extends AskType ? ReplyOf<T> : unknown;
type Handlers = { [T in BoardToHost["type"]]: (p: BoardPanel, m: Msg<T>) => Promise<Out<T>> | Out<T> };
export type Handler = (p: BoardPanel, m: BoardToHost) => Promise<unknown>;

export function makeHandler(panels: BoardHost): Handler {
  const store = panels.store;
  const h: Handlers = {
    ready: () => undefined, // BoardHub 自己处理
    patch: async (p, m) => {
      // 存到这块面板打开的那个文件（p.id），不信白板发来的东西里的 id
      const name = p.board?.name;
      const skipped = await store.patch(p.id, m.patch, { undo: m.undo });
      p.board = store.peek(p.id);
      // 撤销时跳过的共享项：宿主这边留着别的白板的版本，白板换回来
      if (skipped.length) p.post({ type: "shared", cards: skipped });
      if (p.board && p.board.name !== name) { p.view.title = p.board.name; void panels.pushBoards(); }
      return { skipped: skipped.length };
    },
    selection: (p, m) => { p.selection = m; },
    focus: (p, m) => panels.boardFocus(p, m.has),
    answer: (p, m) => p.answer(m.id, m.value),
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
    dispatch: (_p, m) => dispatchAt(m),
    prefetch: (_p, m) => prefetchCall(m),
    callVars: (_p, m) => callVars(m),
    search: (p, m) => search(store, m.q, m.scope, p.id),
    searchPick: (_p, m) => searchPick(m.item),
    entryPoints: () => entryPoints(),
    diff: (_p, m) => diff(m.seg, m.against),
    commits: (_p, m) => commits(m.seg),
    switchCommit: (_p, m) => switchCommit(m.seg, m.commit),
    resolveRef: (p, m) => resolveTyped(p, m.text),
    paste: (_p, m) => pasteCard(m.text),
    github: (_p, m) => githubCard(m.url),
    saveAsset: (_p, m) => store.saveAsset(m.name, m.dataUrl),
    saveImage: (_p, m) => saveNoteImage(store, m.dataUrl),
    readAsset: (_p, m) => readAsset(store, m.file),
    readImageUri: (_p, m) => readImageUri(m.uri),
    exportPng: (_p, m) => exportPng(m.dataUrl, m.name),
    views: (_p, m) => viewsFor(m.segs),
    checkVersions: (p) => p.refreshStale(),
    relocate: (p, m) => relocate(p, m.card),
    locateRepo: (p) => locateRepo(p),
    setSetting: (_p, m) => writeSetting(m.key, m.value),
    webMeta: (_p, m) => webMeta(store, m.url),
    gh: (_p, m) => ghQuery(m.q),
    stickerPacks: () => readPacks(),
    tidy: async (_p, m) => Object.fromEntries(await tidy(m.cards, m.links, m.fixed)),
    openStickerDir: () => openStickerDir(),
    copyDiagnostics: (p, m) => copyDiagnostics(prompts(p), p.board, m.board),
    log: (_p, m) => log(m.level, m.text),
    openBoard: (_p, m) => openOnBoard(panels, m.id, m.card, m.line, m.sticker),
    copyCards: async (p, m) => {
      panels.clip = { board: p.id, cards: m.cards, text: m.text };
      // 别的窗口（别的项目）也能贴：记进全局存储目录
      const recorded = recordClip(store.dir(), panels.clip).catch((e) => log("warn", `copyCards: ${e instanceof Error ? e.message : e}`));
      panels.broadcast({ type: "host", host: { clip: { board: p.id, n: m.cards.length } } });
      // 白板里写剪贴板可能被 webview 拦下：宿主再写一次，⌘V 收到的文字和记下的一样。
      // rich = 白板自己写了文字 + 图片：宿主再写只有文字的会把图盖掉（白板写不了时会再发 copyText）
      if (m.text && !m.rich) void workspace().ui.copy(m.text);
      await recorded;
    },
    pasteCards: async (p, m) => {
      const o = { text: m.text, copy: !!m.copy };
      // 这个窗口的剪贴板对不上：看是不是别的窗口复制的卡
      const r = (await pasteClip(store, panels.clip, p.id, o)) ?? (await pasteFar(store, p.id, o));
      if (!r) return null;
      const segs: Segment[] = r.cards.flatMap((x) => [...(x.card.kind === "code" ? x.card.segments : []), ...(x.sidenotes ?? []).flatMap((n) => (n.kind === "code" ? [n.code] : []))]);
      return { ...r, views: await viewsFor(segs) };
    },
    deleteEverywhere: async (p, m) => (await store.deleteEverywhere(m.card, p.id)).length,
    confirm: async (_p, m) => (await workspace().ui.warn(m.text, { modal: true, detail: m.detail }, m.ok)) === m.ok,
    pickFile: () => pickImage(),
    searchName: (_p, m) => searchName(m.name),
    genSource: (_p, m) => genSource(m.from),
    complete: (p, m) => complete(p, m.before, m.after),
    codeDoc: (_p, m) => codeDoc(m.id, m.lang, m.text, m.near),
    codeDocClose: (_p, m) => codeDocClose(m.id),
    lspComplete: (_p, m) => lspComplete(m.id, m.text, m.line, m.col, m.trigger),
    lspHover: (_p, m) => lspHover(m.id, m.text, m.line, m.col),
    lspSignature: (_p, m) => lspSignature(m.id, m.text, m.line, m.col, m.trigger),
    captureRun: (p) => void captureFlow(store.dir(), p, prompts(p)),
    exportBoards: (p) => void exportFlow(store, [p.id], p.board?.name ?? "Board"),
    applyRun: (p) => void applyFlow(store.dir(), p, prompts(p)),
    questions: () => allQuestions(store),
    permalinks: (_p, m) => permalinks(m.segs),
    exportFile: (_p, m) => exportFile(store, m.kind, m.name, m.text),
    copyText: (_p, m) => workspace().ui.copy(m.text),
    imageAi: (p, m) => imageAiJob(jobsOf(p), m.job, m.op),
    imageAiCancel: (p, m) => { jobsOf(p).get(m.job)?.abort(); },
    setDeepseekKey: async () => { await workspace().ai?.setDeepseekKey?.(); },
    aiInfo: () => aiInfo(),
    aiKey: async (_p, m) => {
      const ai = workspace().ai;
      if (m.action === "set") await ai?.setDeepseekKey?.();
      else await ai?.clearDeepseekKey?.();
      return aiInfo();
    },
    variantSources: (_p, m) => variantSources(m.seg),
    addVariant: (_p, m) => addVariant(m.segs, m.from),
    skeletons: async (_p, m) => {
      await store.list(); // 缓存里还没有的白板先扫进来
      return Object.fromEntries(m.ids.map((id) => [id, panels.skeleton(id)]));
    },
    boardRefs: async (p) => {
      await store.list(); // 缓存里还没有的白板先扫进来
      return panels.boardRefs(p);
    },
    refPicked: (_p, m) => panels.refPicked(m.b, m.id),
    subCard: async (_p, m) => {
      const b = store.peek(m.board) ?? (await store.load(m.board));
      const r = b && subCardOf(b, m.card);
      if (!r) return null;
      const segs = [r.card, ...(r.cols ?? [])].flatMap((c) => (isCode(c) ? c.segments : []));
      return { ...r, views: segs.length ? await viewsFor(segs) : {} };
    },
    newBoard: async (p, m) => {
      // Turn into Board：白板拆好的新白板（schema 校验一遍）。共享卡在新白板上还是共享卡；放在父白板的组里
      const b = loadBoard(structuredClone({ ...m.board, version: BOARD_VERSION }));
      if (!SAFE_BOARD_ID.test(b.id) || (await store.load(b.id))) throw new Error("Bad board id.");
      const refs = [...store.refsOf(p.id)].filter((id) => b.cards.some((c) => c.id === id));
      await store.save(b, { group: store.groupOf(p.id) ?? null, refs });
      return true;
    },
    enterBoard: async (p, m) => {
      // 不能套成环：子白板里（一路往下）有这块白板
      const metas = await store.list();
      const subs = (id: string) => metas.find((x) => x.id === id)?.subs;
      if (m.id === p.id || wouldCycle(subs, p.id, m.id)) { p.toast("Can't open a board inside itself."); return; }
      const name = p.board?.name ?? metas.find((x) => x.id === p.id)?.name ?? "";
      const crumbs = [...p.crumbs, { id: p.id, name, frame: m.frame }], cams = [...p.cams, m.cam];
      // 要带到的卡在更深的子白板里（[[ 链接）：一路进去，每一层都进面包屑，回去时落在那一层存着的镜头上
      let to = m.id;
      const start = m.reveal ? store.peek(m.id) ?? (await store.load(m.id)) : undefined;
      for (const hop of (start && m.reveal && cardPath(start, m.reveal, (id) => store.peek(id))) || []) {
        const at = store.peek(to)!;
        crumbs.push({ id: to, name: at.name, frame: hop.frame }); cams.push(at.cam);
        to = hop.board;
      }
      const ok = await panels.switchBoard(p, to, { crumbs, cams, walk: m.walk });
      if (m.reveal) (ok ? p : panels.get(to))?.post({ type: "reveal", card: m.reveal });
      if (!ok) p.toast("That board is already open in another tab.");
    },
    leaveBoard: async (p, m) => {
      if (!p.crumbs.length) return;
      const depth = Math.max(0, Math.min(p.crumbs.length - 1, m.depth ?? p.crumbs.length - 1));
      const to = p.crumbs[depth];
      const ok = await panels.switchBoard(p, to.id, { crumbs: p.crumbs.slice(0, depth), cams: p.cams.slice(0, depth), walk: m.walk, cam: p.cams[depth] });
      if (!ok) p.toast("That board is already open in another tab.");
    },
    dropBoard: async (p, m) => {
      if ((await store.list()).some((x) => x.id !== p.id && x.subs?.includes(m.id))) return false;
      // 和存下来时一样校验一遍再比（newBoard 存的是校验过的那份）
      if (!(await store.dropIfUnchanged(m.id, loadBoard(structuredClone({ ...m.made, version: BOARD_VERSION }))))) return false;
      closeOthers(p, m.id);
      return true;
    },
    restoreBoard: async (p, m) => {
      const ok = await store.restore(m.id, store.groupOf(p.id));
      if (ok) await panels.pushBoards();
      return ok;
    },
    deleteBoard: async (p, m) => {
      const b = await store.load(m.id);
      if (!b) return false;
      const ok = await workspace().ui.warn(`Delete board “${b.name}”?`, { modal: true, detail: `${b.cards.length} cards and their links will be removed. Your code is not affected.` }, "Delete");
      if (ok !== "Delete") return false;
      await removeBoard(p, m.id);
      return true;
    },
  };
  async function removeBoard(p: BoardPanel, id: string) {
    await store.remove(id);
    closeOthers(p, id);
  }
  /** 一块白板删掉了（放进了 .trash）：开着它的别的面板关掉，侧栏刷新 */
  function closeOthers(p: BoardPanel, id: string) {
    const open = panels.get(id);
    if (open && open !== p) open.view.dispose();
    if (panels.target === id) panels.setTarget(undefined);
    void panels.pushBoards();
  }
  return async (p, m) => (h[m.type] as ((p: BoardPanel, m: BoardToHost) => unknown) | undefined)?.(p, m); // 不认识的消息（更新的白板）不理
}

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

/** 「新版本」diff：钉住的段 vs HEAD（against 可以是别的 commit / branch，或 "working" = 工作区） */
async function diff(seg: Segment, against?: string): Promise<DiffData> {
  const wt = against === "worktree" || against === "working";
  const name = seg.symbol?.qual ?? `${path.basename(seg.path)} ${seg.start}–${seg.end}`;
  const title = wt ? `Uncommitted Changes · ${name}` : `New Version · ${name}`;
  const left = { label: wt ? versionLabel(seg.version) : `Pinned ${versionLabel(seg.version)}`, path: seg.path, start: seg.start, text: seg.text, html: await highlight(seg.text, seg.lang, (await versionText(seg)) ?? undefined) };
  const abs = absOf(seg);
  const empty = (label: string): DiffData => ({ title, left, right: { label, path: seg.path, start: seg.start, text: [], html: [] }, canUpdate: false });
  if (!abs || !hasLocalFile(seg.src)) return empty("No newer version");
  let text: string | null = null, label = "", newVersion = seg.version, lastChange: string | undefined;
  const root = seg.version.kind === "git" ? await repoRootOf(abs) : null;
  const rel = root ? path.relative(root, abs).split(path.sep).join("/") : seg.path;
  if (wt || seg.version.kind !== "git" || seg.version.uncommitted) {
    text = await readText(abs);
    label = seg.version.kind === "git" ? "Working Tree" : `Installed ${await currentVersionLabel(abs, seg.version)}`;
    if (seg.version.kind === "git") newVersion = { kind: "git", commit: (root && (await headOf(root))) || seg.version.commit, uncommitted: true };
    else if (text !== null) newVersion = await currentVersion(abs, seg.version, text);
  } else if (root) {
    // upstream：有 Variant 的卡跟上游分支比（HEAD 可能是我的分支）
    const ref = against === "upstream" ? await upstreamRef(root) : against;
    const sha = ref ? await resolveRef(root, ref) : await headOf(root);
    if (!sha) throw new Error(`Unknown commit “${against}”.`);
    text = await showFile(root, sha, rel);
    label = `${ref && ref !== "HEAD" ? ref.replace(/^origin\//, "") : "HEAD"} ${sha.slice(0, 7)}`;
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

/** commit 下拉：改过这个符号的 commit（git log -L） */
async function commits(seg: Segment): Promise<Commit[]> {
  if (seg.version.kind !== "git" || !hasLocalFile(seg.src)) return [];
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

/** 打开一块白板，选中那张卡（和那一行：别的白板上连进来的箭头从哪一行出发、问题贴在哪一行）；sticker = 再打开那个问题 */
export async function openOnBoard(panels: BoardHost, id: string, card?: string, line?: number, sticker?: string) {
  const np = await panels.show(id);
  if (!np || !card) return;
  const c = np.board && findCard(np.board, card)?.card;
  const seg = line !== undefined && c && isCode(c) ? c.segments.find((s) => line >= s.start && line <= s.end) : undefined;
  np.post({ type: "reveal", card, ...(seg ? { seg: seg.id, lines: [line!, line!] as [number, number] } : {}), ...(sticker ? { sticker } : {}) });
}

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
  const mime = sniffImage(buf)?.mime ?? (sniffSvg(buf) ? "image/svg+xml" : null);
  if (!mime) { void workspace().ui.warn(`${path.basename(file)} is not a PNG, JPEG, WebP, GIF or SVG image.`, {}); return null; }
  return `data:${mime};base64,${buf.toString("base64")}`;
}

/** 一个文件里的函数 / 类（Relocate 的候选） */
type Spot = { abs: string; qual: string; kind: string; start: number; end: number; defLine: number };
async function spotsIn(abs: string): Promise<Spot[]> {
  const text = await readText(abs);
  return text === null ? [] : analysisOf(langOf(abs), text).symbols.map((s) => ({ abs, qual: s.qual, kind: s.kind, start: s.start, end: s.end, defLine: s.defLine }));
}

/**
 * 符号找不到（删了、改了名、挪到了别的文件）：选它现在在哪，段换成那里的代码。候选：工作区里同名的函数 / 类、原来那个文件（还在的话）里的，
 * 都不是就另选一个文件
 */
async function relocate(p: BoardPanel, cardId: string) {
  const f = p.board && findCard(p.board, cardId);
  if (!f || !isCode(f.card)) throw new Error("Card not found.");
  const seg = f.card.segments.find((s) => s.symbol) ?? f.card.segments[0];
  const ui = workspace().ui, ask = prompts(p);
  const name = seg.symbol?.qual.split(".").pop();
  const old = absOf(seg);
  const spots = [...(name ? await lookupName(name) : []), ...(old ? await spotsIn(old) : [])]
    .filter((s, i, all) => all.findIndex((o) => o.abs === s.abs && o.start === s.start) === i);
  const item = (s: Spot) => ({ label: `${s.kind === "class" ? "$(symbol-class)" : "$(symbol-method)"} ${s.qual}`, description: `${hostPath(s.abs)}:${s.defLine}`, s });
  const where = `Where is ${seg.symbol?.qual ?? "this code"} now?`;
  const pick = await ask.pick([...spots.map(item), { label: "$(folder-opened) Choose File…", description: "", s: undefined }], { placeHolder: where, matchOnDescription: true });
  if (!pick) return;
  let to = pick.s;
  if (!to) {
    const abs = await ui.openDialog({ label: "Look in This File", title: where });
    if (!abs) return;
    to = (await ask.pick((await spotsIn(abs)).map(item), { placeHolder: where }))?.s;
    if (!to) return;
  }
  const text = await readText(to.abs);
  if (text === null) throw new Error(`${hostPath(to.abs)} not found.`);
  const ns = await makeSegment(await locOfFile(to.abs), splitLines(text), to.start, to.end, { lang: langOf(to.abs), symbol: { qual: to.qual, kind: to.kind === "class" ? "class" : "function" } });
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
    const r = await prompts(p).pick([...miss.entries()].map(([k, s]) => ({ label: srcLabel(s.src), description: k, k })), { placeHolder: "Which repo do you want to locate?" });
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



/** 图片的 AI 操作：每块面板还在等的请求（白板给的 job 号 → 取消用的） */
const imageJobs = new WeakMap<BoardPanel, Map<number, AbortController>>();
const jobsOf = (p: BoardPanel) => { let m = imageJobs.get(p); if (!m) imageJobs.set(p, (m = new Map())); return m; };

/** Note 的灰字补全：同一块面板新的请求来了就取消旧的；没有模型回 null */
const inflight = new WeakMap<BoardPanel, AbortController>();
async function complete(p: BoardPanel, before: string, after: string): Promise<string | null> {
  const ai = workspace().ai;
  if (!ai) return null;
  inflight.get(p)?.abort();
  const ac = new AbortController();
  inflight.set(p, ac);
  const raw = ai.complete
    ? await ai.complete(before, after, { signal: ac.signal })
    : await ai.ask(COMPLETE_SYSTEM, completePrompt(before, after), { signal: ac.signal, maxChars: 600 }).then((r) => r === undefined ? r : spaceChatReply(r, before));
  if (ac.signal.aborted || raw === undefined) return null;
  return cleanCompletion(raw, before, after) || null;
}
