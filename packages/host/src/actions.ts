import * as path from "node:path";
import { allCodeCards, estSize, placeCards, removeCards, type Board, type CardCopy, type CodeCard, type KeyAction } from "@codeboard/core";
import { analysisOf } from "./analysis";
import { cardsFromEditor, symCard, widthFor, withViews, type Built } from "./cards";
import type { BoardHost } from "./boards";
import { absOf, locOfFile } from "./source";
import { moveIntoProject, projectDir, PROJECT_DIR, type Storage } from "./storage";
import { workingPlace } from "./versions";
import { viewsFor } from "./views";
import { copyDiagnostics } from "./diagnostics";
import { applyFlow, captureFlow } from "./runs";
import { prompts } from "./prompts";
import { copyToProject, otherProjects, removeMoved } from "./transfer";
import { BUNDLE_EXT, exportFlow, importFile } from "./bundle";
import { langOf, readText, splitLines, workspace, ws0 } from "./ws";

/** 侧栏的节点（命令参数） */
export type Node = { kind: "board"; id: string } | { kind: "group"; name: string } | undefined;

/** 命令 id → 做什么（参数是 VS Code 命令收到的参数，文件已经换成绝对路径） */
export function makeActions(panels: BoardHost, store: Storage) {
  const ui = () => workspace().ui;
  const active = () => panels.all().find((p) => p.view.active);
  const boardArg = (a: unknown): string | undefined => (typeof a === "string" ? a : (a as Node)?.kind === "board" ? (a as { id: string }).id : undefined);

  /** Add to 的目标白板：最近聚焦的；没有就第一张；一张都没有就新建 */
  // Commands that run at once share one answer: otherwise Alt+B and Open Board pressed together in a workspace without a board
  // would each find no board and each create a "New Board"
  let targeting: Promise<string> | null = null;
  const targetId = (): Promise<string> => (targeting ??= (async () => {
    const metas = await store.list();
    if (panels.target && metas.some((m) => m.id === panels.target)) return panels.target;
    const id = metas[0]?.id ?? (await store.create("New Board")).id;
    panels.setTarget(id);
    return id;
  })().finally(() => { targeting = null; }));

  const notify = async (b: { id: string; name: string }, n: number, undo: () => Promise<void>) => {
    const r = await ui().info(`Added ${n > 1 ? `${n} cards` : "to"} “${b.name}”`, "Open", "Undo");
    if (r === "Open") await panels.show(b.id);
    else if (r === "Undo") await undo();
  };

  /** 编辑器里 ⌥B 之后接着按 ⌘Z 撤销的那次添加（焦点留在编辑器：⌥B 是边读边收集，不抢焦点） */
  let lastAdd: (() => Promise<void>) | null = null;
  const armUndo = (f: () => Promise<void>) => { lastAdd = f; ui().undoAddKey?.(true); };

  /**
   * 撤销一次添加：只拿掉那几张卡（还在的）。白板开着（可能是加完以后才打开的）就交给白板做，是它撤销栈里的一步；
   * 关着就改存着的白板。之后在白板上做的别的改动都不动
   */
  const undoAdd = async (boardId: string, ids: string[]) => {
    const p = panels.get(boardId);
    if (p) { p.post({ type: "undoAdd", cards: ids }); return; }
    const b = await store.update(boardId, (b) => {
      const gone = ids.filter((id) => b.cards.some((c) => c.id === id));
      if (!gone.length) return false;
      removeCards(b, gone);
    });
    if (b) void ui().info(`Removed from “${b.name}”`);
  };

  /** 把卡送到白板：开着就发给白板（它决定位置）；没开就直接写进 JSON，这个工作区第一次时在旁边打开白板（焦点留在编辑器） */
  const deliver = async (boardId: string, built: Built) => {
    const cards = await withViews(built.cards);
    const p = panels.get(boardId);
    let name = p?.board?.name ?? "board";
    if (p) {
      const sel = p.selection?.cards[0];
      p.post({ type: "add", cards, ask: built.ask, sel: sel ? { card: sel } : undefined });
    } else {
      const b = await store.update(boardId, (b) => { placeCards(b, stackRight(b, built.cards), { copy: false }); });
      if (!b) return;
      name = b.name;
    }
    const undo = () => undoAdd(boardId, built.cards.map((c) => c.id));
    armUndo(undo);
    if (!p && panels.firstAdd?.()) await panels.show(boardId, { preserveFocus: true });
    else if (!p?.visible) void notify({ id: boardId, name }, cards.length, undo);
  };

  const fromEditor = async (mode: "auto" | "function" | "separate" = "auto"): Promise<Built | undefined> => {
    const ed = workspace().editor.active();
    if (!ed) { void ui().info("Open a file in the editor first."); return; }
    const r = await cardsFromEditor(ed, mode);
    if ("error" in r) { void ui().info(r.error); return; }
    return r;
  };

  /** 只导航不建卡：找含这几行的卡，在几张白板上时先选白板 */
  const reveal = async (abs: string, start: number, end: number) => {
    const hits = await findOnBoards(store, abs, start, end);
    if (!hits.length) { void ui().info("These lines are not on any board."); return; }
    let h = hits.find((x) => x.board.id === panels.target) ?? hits[0];
    const boards = [...new Map(hits.map((x) => [x.board.id, x.board])).values()];
    if (boards.length > 1) {
      const r = await ui().pick(boards.map((b) => ({ label: `$(layout) ${b.name}`, description: b.id === panels.target ? "target" : undefined, b })), { placeHolder: "Reveal on which board?" });
      if (!r) return;
      h = hits.find((x) => x.board.id === r.b.id)!;
    }
    const p = await panels.show(h.board.id);
    p?.post({ type: "reveal", card: h.card.id, seg: h.seg, lines: h.lines });
  };

  /** Copy / Move to Another Project…：选一个登记过的别的项目，拷过去（transfer.ts）；Move 再从这边删掉（放进 .trash），和 Delete Board 一样先关面板 */
  const toProject = async (a: unknown, move: boolean) => {
    const id = boardArg(a) ?? panels.target;
    const b = id && (await store.load(id));
    if (!b || !panels.globalState) return;
    const ps = await otherProjects(panels.globalState, store.dir());
    if (!ps.length) { void ui().info("No other project found. Open the other project once with CodeBoard so it shows up here."); return; }
    const r = await ui().pick(ps.map((p) => ({ label: `$(folder) ${p.name}`, description: p.folders.join(" · ") || p.dir, p })), { placeHolder: `${move ? "Move" : "Copy"} “${b.name}” to which project?`, matchOnDescription: true });
    if (!r) return;
    if (move) {
      const ok = await ui().warn(`Move board “${b.name}” to ${r.p.name}?`, { modal: true, detail: "It is removed from this project (restorable from .trash). Sub-boards, shared cards and images go with it." }, "Move");
      if (ok !== "Move") return;
    }
    const t = await copyToProject(store, b.id, r.p);
    if (!t) return;
    if (move) {
      await removeMoved(store, t, (x) => { panels.get(x)?.view.dispose(); if (panels.target === x) panels.setTarget(undefined); });
      await panels.pushBoards();
    }
    void ui().info(`${move ? "Moved" : "Copied"} “${b.name}” to ${r.p.name}.`);
  };

  /** Export Boards…：侧栏的白板 / 组，或者从列表里选（所有白板、一个组、一块白板），存成一个 .codeboard */
  const exportBoards = async (a: unknown) => {
    const metas = await store.list();
    let pick: { roots: string[]; name: string } | undefined;
    const id = boardArg(a);
    if (id) { const m = metas.find((x) => x.id === id); if (m) pick = { roots: [m.id], name: m.name }; }
    else if ((a as Node)?.kind === "group") { const g = (a as { name: string }).name; pick = { roots: metas.filter((m) => m.group === g).map((m) => m.id), name: g }; }
    else {
      if (!metas.length) { void ui().info("There are no boards to export."); return; }
      const count = (n: number) => `${n} board${n === 1 ? "" : "s"}`;
      const groups = [...new Set(metas.flatMap((m) => (m.group ? [m.group] : [])))].sort();
      pick = await ui().pick([
        { label: "$(files) All Boards", description: count(metas.length), roots: metas.map((m) => m.id), name: workspace().files.name() || "Boards" },
        ...groups.map((g) => { const ms = metas.filter((m) => m.group === g); return { label: `$(folder) ${g}`, description: count(ms.length), roots: ms.map((m) => m.id), name: g }; }),
        ...metas.map((m) => ({ label: `$(layout) ${m.name}`, description: m.group, roots: [m.id], name: m.name })),
      ], { placeHolder: "Export which boards? Sub-boards, shared cards and images go with them.", matchOnDescription: true });
    }
    if (pick?.roots.length) await exportFlow(store, pick.roots, pick.name);
  };

  /** Import Boards…：file = 拖到侧栏上的那个包；否则让用户选。导入后打开第一块 */
  const importBoards = async (file?: string) => {
    file ??= await ui().openDialog({ filters: { "CodeBoard Boards": [BUNDLE_EXT, "zip"] }, label: "Import", title: "Import Boards" });
    if (!file) return;
    let r: Awaited<ReturnType<typeof importFile>>;
    try { r = await importFile(store, file); } catch (e) {
      void ui().error(`Can't import ${path.basename(file)}: ${e instanceof Error ? e.message : e}`);
      return;
    }
    await panels.pushBoards();
    await panels.show(r.first);
    const from = r.manifest.folders.length ? ` from ${r.manifest.folders.join(", ")}` : "";
    const renamed = r.renamed ? ` ${r.renamed} renamed: this project already had ${r.renamed === 1 ? "its name or id" : "their names or ids"}.` : "";
    void ui().info(`Imported ${r.boards} board${r.boards === 1 ? "" : "s"}${from}.${renamed}`);
  };

  return {
    // 白板聚焦时，VS Code 自己的快捷键（⌘K 和弦、⌘1 切编辑组、⌘± 缩放窗口……）会抢在白板前面；
    // 这些键在白板里另有用途，所以注册同样的键，转给白板处理
    "codeboard.boardKey": (action: KeyAction) => active()?.post({ type: "key", action }),
    "codeboard.openSettings": async () => {
      const p = active() ?? (panels.target ? await panels.show(panels.target) : panels.all()[0]);
      if (!p) { void ui().info("Open a board first. CodeBoard settings are also under Settings → Extensions → CodeBoard."); return; }
      p.view.reveal();
      p.post({ type: "key", action: "openSettings" });
    },
    // Asked on the active board (where the keyboard is when the command runs from the palette over it), else in VS Code
    "codeboard.captureRun": async () => { const a = active(); await captureFlow(store.dir(), a ?? (panels.target ? panels.get(panels.target) : undefined), prompts(a)); },
    "codeboard.applyRun": async () => { const a = active(); await applyFlow(store.dir(), a ?? (panels.target ? panels.get(panels.target) : undefined), prompts(a)); },
    "codeboard.copyDiagnostics": () => { const a = active(); return copyDiagnostics(prompts(a), (a ?? (panels.target ? panels.get(panels.target) : undefined))?.board); },

    "codeboard.addToBoard": async () => {
      const b = await fromEditor();
      if (b) await deliver(await targetId(), b);
    },
    "codeboard.undoAdd": async () => {
      const f = lastAdd;
      lastAdd = null;
      ui().undoAddKey?.(false);
      await f?.();
    },
    "codeboard.addSeparateCards": async () => {
      const b = await fromEditor("separate");
      if (b) await deliver(await targetId(), b);
    },
    "codeboard.addFunction": async () => {
      const b = await fromEditor("function");
      if (b) await deliver(await targetId(), b);
    },
    "codeboard.addToAnotherBoard": async () => {
      const b = await fromEditor();
      if (!b) return;
      const id = await pickBoard(store, "Add to which board?", true);
      if (!id) return;
      panels.setTarget(id);
      await deliver(id, b);
    },
    "codeboard.addToSelectedCard": async () => {
      const id = await targetId();
      const p = panels.get(id);
      const sel = p?.selection?.cards[0];
      const card = sel && p?.board ? allCodeCards(p.board).find((c) => c.id === sel) : undefined;
      if (!p || !card) { void ui().info("Select a code card on the board first."); return; }
      const b = await fromEditor();
      if (!b) return;
      for (const seg of b.cards.flatMap((c) => c.segments)) {
        const views = await viewsFor([seg]);
        p.post({ type: "appendSegment", card: card.id, seg, view: views[seg.id] });
      }
    },
    "codeboard.addSidenote": async () => {
      const b = await fromEditor();
      if (!b) return;
      const seg = b.cards[0].segments[0];
      const p = await panels.show(await targetId(), { preserveFocus: true });
      if (!p) return;
      p.post({ type: "addSidenote", seg, view: (await viewsFor([seg]))[seg.id] });
    },

    // CodeLens「+ Card」：把这个符号加到目标白板
    "codeboard.addSymbol": async (abs: string, qual: string) => {
      const text = await readText(abs);
      if (text === null) return;
      const lang = langOf(abs);
      const sym = analysisOf(lang, text).symbols.find((s) => s.qual === qual);
      if (!sym) return;
      const card = await symCard(await locOfFile(abs), splitLines(text), sym, lang);
      await deliver(await targetId(), { cards: [card] });
    },

    "codeboard.revealOnBoard": async () => {
      const ed = workspace().editor.active();
      if (!ed) return;
      const s = ed.selections[0];
      await reveal(ed.path, s.startLine, s.endLine - (s.endCol === 0 && s.endLine > s.startLine ? 1 : 0));
    },
    // CodeLens「on N boards」
    "codeboard.revealSymbol": async (abs: string, line: number, end: number) => reveal(abs, line, end),

    "codeboard.switchTarget": async () => {
      const id = await pickBoard(store, "Add to which board from the editor?", true);
      if (id) panels.setTarget(id);
    },

    "codeboard.openBoard": async (a?: unknown, o?: { here?: boolean }) => {
      const id = boardArg(a) ?? (await targetId());
      await panels.show(id, { here: !!o?.here });
    },
    // 侧栏里读不了的白板：不开（开了就是空白板，存盘会盖掉原文件），说清楚为什么，给个手改 JSON 的入口
    "codeboard.openBrokenBoard": async (file: string) => {
      const metas = await store.list();
      const bad = store.broken().find((b) => b.file === file);
      if (!bad) { // 点之前文件已经修好了
        const m = metas.find((x) => store.fileOf(x.id) === file);
        if (m) await panels.show(m.id, { here: true });
        return;
      }
      const r = await ui().error(`Can't open board “${bad.name}” (${path.basename(file)}): ${bad.reason}`, "Open JSON", "Reveal in Folder");
      if (r === "Open JSON") await workspace().editor.open(file);
      else if (r === "Reveal in Folder") await ui().revealInOS(file);
    },
    "codeboard.openBoardToSide": async (a?: unknown) => {
      const id = boardArg(a);
      if (id) await panels.show(id, { side: true });
    },
    "codeboard.newBoard": async (a?: unknown) => {
      const group = (a as Node)?.kind === "group" ? (a as { name: string }).name : undefined;
      const name = await ui().input({ prompt: "Name of the new board", value: "New Board", placeHolder: "e.g. generate() end to end" });
      if (!name?.trim()) return;
      const b = await store.create(name.trim(), group);
      await panels.show(b.id);
    },
    "codeboard.renameBoard": async (a?: unknown) => {
      const id = boardArg(a) ?? panels.target;
      const b = id && (await store.load(id));
      if (!b) return;
      // From the sidebar (a): VS Code's input box, the keyboard is there; from the palette over the board: the board's dialog
      const on = a === undefined ? active() : undefined;
      const name = await prompts(on?.id === b.id ? on : undefined).input({ title: "Rename Board", ok: "Rename", prompt: "Rename board", value: b.name });
      if (!name?.trim() || name.trim() === b.name) return;
      const p = panels.get(b.id);
      if (p?.board) {
        // 白板开着：让白板改（它持有状态，改完会存回来）
        p.post({ type: "rename", name: name.trim() });
        p.board.name = name.trim();
        p.view.title = name.trim();
      }
      await store.rename(b.id, name.trim());
      await panels.pushBoards();
    },
    "codeboard.duplicateBoard": async (a?: unknown) => {
      const id = boardArg(a);
      if (id) await store.duplicate(id);
    },
    "codeboard.deleteBoard": async (a?: unknown) => {
      const id = boardArg(a);
      const b = id && (await store.load(id));
      if (!b) return;
      const ok = await ui().warn(`Delete board “${b.name}”?`, { modal: true, detail: `${b.cards.length} cards and their links will be removed. Your code is not affected.` }, "Delete");
      if (ok !== "Delete") return;
      panels.get(b.id)?.view.dispose();
      await store.remove(b.id);
      if (panels.target === b.id) panels.setTarget(undefined);
      await panels.pushBoards();
    },
    // 白板搬进项目的 .codeboard/（git 能管，克隆了仓库的人看得到）；之后这个项目一直用它
    "codeboard.moveBoardsIntoProject": async () => {
      const to = projectDir();
      if (to) {
        const ok = await ui().warn(`Move this project's boards into ${PROJECT_DIR} in ${path.basename(ws0())}?`, { modal: true, detail: `Boards, groups, shared cards, images and run records are stored in ${to} from now on, where git can track them. Anyone who opens the repository with CodeBoard sees them. Deleted boards (.trash) are ignored by git.` }, "Move");
        if (ok !== "Move") return;
      }
      const r = await moveIntoProject(store);
      if (!r.moved) { void ui().info(r.why); return; }
      await panels.pushBoards();
      if ((await ui().info(`Boards moved into ${PROJECT_DIR}. Commit it to share them with the repository.`, "Reveal in Folder")) === "Reveal in Folder") await ui().revealInOS(r.to);
    },
    "codeboard.copyToProject": (a?: unknown) => toProject(a, false),
    "codeboard.moveToProject": (a?: unknown) => toProject(a, true),
    "codeboard.exportBoards": (a?: unknown) => exportBoards(a),
    "codeboard.importBoards": (a?: unknown) => importBoards(typeof a === "string" ? a : undefined),
    "codeboard.moveToGroup": async (a?: unknown) => {
      const id = boardArg(a);
      if (!id) return;
      const groups = await store.groups();
      const NONE = "(No Group)", NEW = "$(add) New Group…";
      const r = (await ui().pick([NONE, ...groups, NEW].map((label) => ({ label })), { placeHolder: "Move to group" }))?.label;
      if (!r) return;
      let g: string | undefined = r === NONE ? undefined : r;
      if (r === NEW) {
        g = (await ui().input({ prompt: "Group name" }))?.trim();
        if (!g) return;
        await store.newGroup(g);
      }
      await store.move(id, g);
      await panels.pushBoards();
    },
    "codeboard.newGroup": async () => {
      const g = (await ui().input({ prompt: "Name of the new group" }))?.trim();
      if (g) await store.newGroup(g);
    },
    "codeboard.renameGroup": async (a?: Node) => {
      if (a?.kind !== "group") return;
      const g = (await ui().input({ prompt: "Rename group", value: a.name }))?.trim();
      if (g && g !== a.name) { await store.renameGroup(a.name, g); await panels.pushBoards(); }
    },
    "codeboard.deleteGroup": async (a?: Node) => {
      if (a?.kind !== "group") return;
      const ok = await ui().warn(`Delete group “${a.name}”?`, { modal: true, detail: "Boards in it are kept and moved out of the group." }, "Delete Group");
      if (ok !== "Delete Group") return;
      const left = await store.removeGroup(a.name);
      await panels.pushBoards();
      if (!left.length) return;
      // 读不了的白板、不是白板的文件：不删，文件夹留着
      const reveal = await ui().warn(`Group “${a.name}” was kept: it still has files CodeBoard can't open as boards (${left.join(", ")}).`, {}, "Reveal in Folder");
      if (reveal) await ui().revealInOS(path.join(store.dir(), a.name));
    },
    "codeboard.revealInFolder": async (a?: unknown) => {
      const id = boardArg(a);
      const f = id ? store.fileOf(id) : undefined;
      await ui().revealInOS(f ?? store.dir());
    },
    // GITHUB FILES 的 Add Repo…：在目标白板上打开 From GitHub… 面板
    "codeboard.addGithubRepo": async () => {
      const p = await panels.show(await targetId());
      p?.post({ type: "githubPicker" });
    },
  };
}

export async function pickBoard(store: Storage, placeHolder: string, allowNew: boolean): Promise<string | undefined> {
  const metas = await store.list();
  const NEW = { label: "$(add) New Board…", id: "" };
  const items = [...metas.map((m) => ({ label: `$(layout) ${m.name}`, description: m.group, detail: undefined, id: m.id })), ...(allowNew ? [NEW] : [])];
  const ui = workspace().ui;
  const r = await ui.pick(items, { placeHolder });
  if (!r) return;
  if (r.id) return r.id;
  const name = await ui.input({ prompt: "Name of the new board", value: "New Board" });
  return name?.trim() ? (await store.create(name.trim())).id : undefined;
}

/** 白板关着时新卡摆在哪：已有卡片的右边，一张接一张往下排（放进白板用 core placeCards） */
export function stackRight(b: Board, cards: CodeCard[]): CardCopy[] {
  const ps = Object.values(b.place);
  const right = ps.length ? Math.max(...ps.map((p) => p.x + p.w)) + 80 : b.cam.x > 0 ? 80 : -b.cam.x + 80;
  let y = ps.length ? Math.min(...ps.map((p) => p.y)) : 80;
  return cards.map((card) => {
    const place = { x: right, y, w: widthFor(card.segments) };
    y += estSize(card, place).h + 40;
    return { card, place };
  });
}

export type Hit = { board: Board; card: CodeCard; seg: string; lines: [number, number] };

/** 所有白板上含有这个文件这几行的卡（按段在工作区里的位置算） */
export async function findOnBoards(store: Storage, abs: string, start: number, end: number): Promise<Hit[]> {
  const out: Hit[] = [];
  for (const { board } of await store.all()) {
    for (const card of allCodeCards(board)) for (const s of card.segments) {
      if (absOf(s) !== abs) continue;
      const wp = await workingPlace(s);
      if (!wp || wp.end < start || wp.start > end) continue;
      const d = s.start - wp.start;
      out.push({ board, card, seg: s.id, lines: [Math.max(wp.start, start) + d, Math.min(wp.end, end) + d] });
    }
  }
  return out;
}
