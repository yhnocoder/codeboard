// 编辑器和侧栏的命令：Add to Board（⌥B）、Add to Another Board…、Add to Selected Card、Add Function at Cursor、
// Add as Sidenote（⌥S）、Reveal on Board，以及白板的新建 / 改名 / 删除 / 分组。
import * as vscode from "vscode";
import * as path from "node:path";
import { allCodeCards, cardTitle, type Board, type CodeCard } from "@codeboard/core";
import { analysisOf } from "./analysis";
import { cardsFromEditor, symCard, withViews, type Built } from "./cards";
import type { Panels } from "./panel";
import { absOf, locOfFile } from "./source";
import type { Storage } from "./storage";
import { boardSegments, workingPlace } from "./versions";
import { viewsFor } from "./views";
import { readText, splitLines } from "./ws";

type Node = { kind: "board"; id: string } | { kind: "group"; name: string } | undefined;

export function registerCommands(ctx: vscode.ExtensionContext, panels: Panels, store: Storage) {
  const cmd = (id: string, fn: (...a: any[]) => unknown) => ctx.subscriptions.push(vscode.commands.registerCommand(id, fn));
  const boardArg = (a: unknown): string | undefined => (typeof a === "string" ? a : (a as Node)?.kind === "board" ? (a as { id: string }).id : undefined);

  /** Add to 的目标白板：最近聚焦的；没有就第一张；一张都没有就新建 */
  const targetId = async (): Promise<string> => {
    const metas = await store.list();
    if (panels.target && metas.some((m) => m.id === panels.target)) return panels.target;
    const id = metas[0]?.id ?? (await store.create("New Board")).id;
    panels.setTarget(id);
    return id;
  };

  const notify = async (b: { id: string; name: string }, n: number, undo?: () => Promise<void>) => {
    const r = await vscode.window.showInformationMessage(`Added ${n > 1 ? `${n} cards` : "to"} “${b.name}”`, "Open", ...(undo ? ["Undo"] : []));
    if (r === "Open") await panels.show(b.id);
    else if (r === "Undo" && undo) await undo();
  };

  /** 把卡送到白板：开着就发给白板（它决定位置）；没开就直接写进 JSON */
  const deliver = async (boardId: string, built: Built) => {
    const cards = await withViews(built.cards);
    const p = panels.get(boardId);
    if (p) {
      const sel = p.selection?.cards[0];
      p.post({ type: "add", cards, ask: built.ask, sel: sel ? { card: sel } : undefined });
      if (!p.visible) void notify({ id: boardId, name: p.board?.name ?? "board" }, cards.length);
      return;
    }
    const b = await store.load(boardId);
    if (!b) return;
    const before = structuredClone(b);
    placeCards(b, built.cards);
    await store.save(b);
    void notify(b, cards.length, async () => { await store.save(before); });
  };

  const fromEditor = async (mode: "auto" | "function" = "auto"): Promise<Built | undefined> => {
    const ed = vscode.window.activeTextEditor;
    if (!ed) { void vscode.window.showInformationMessage("Open a file in the editor first."); return; }
    const r = await cardsFromEditor(ed, mode);
    if ("error" in r) { void vscode.window.showInformationMessage(r.error); return; }
    return r;
  };

  cmd("codeboard.addToBoard", async () => {
    const b = await fromEditor();
    if (b) await deliver(await targetId(), b);
  });
  cmd("codeboard.addFunction", async () => {
    const b = await fromEditor("function");
    if (b) await deliver(await targetId(), b);
  });
  cmd("codeboard.addToAnotherBoard", async () => {
    const b = await fromEditor();
    if (!b) return;
    const id = await pickBoard(store, "Add to which board?", true);
    if (!id) return;
    panels.setTarget(id);
    await deliver(id, b);
  });
  cmd("codeboard.addToSelectedCard", async () => {
    const id = await targetId();
    const p = panels.get(id);
    const sel = p?.selection?.cards[0];
    const card = sel && p?.board ? allCodeCards(p.board).find((c) => c.id === sel) : undefined;
    if (!p || !card) { void vscode.window.showInformationMessage("Select a code card on the board first."); return; }
    const b = await fromEditor();
    if (!b) return;
    for (const seg of b.cards.flatMap((c) => c.segments)) {
      const views = await viewsFor([seg]);
      p.post({ type: "appendSegment", card: card.id, seg, view: views[seg.id] });
    }
  });
  cmd("codeboard.addSidenote", async () => {
    const b = await fromEditor();
    if (!b) return;
    const seg = b.cards[0].segments[0];
    const p = await panels.show(await targetId(), { preserveFocus: true });
    if (!p) return;
    p.post({ type: "addSidenote", seg, view: (await viewsFor([seg]))[seg.id] });
  });

  // CodeLens「+ Card」：把这个符号加到目标白板
  cmd("codeboard.addSymbol", async (uri: vscode.Uri, qual: string) => {
    const text = await readText(uri.fsPath);
    if (text === null) return;
    const doc = await vscode.workspace.openTextDocument(uri);
    const sym = analysisOf(doc.languageId, text).symbols.find((s) => s.qual === qual);
    if (!sym) return;
    const card = await symCard(await locOfFile(uri.fsPath), splitLines(text), sym, doc.languageId);
    await deliver(await targetId(), { cards: [card] });
  });

  cmd("codeboard.revealOnBoard", async () => {
    const ed = vscode.window.activeTextEditor;
    if (!ed) return;
    const s = ed.selection;
    await reveal(ed.document.uri.fsPath, s.start.line + 1, s.end.line + 1 - (s.end.character === 0 && s.end.line > s.start.line ? 1 : 0));
  });
  // CodeLens「on N boards」
  cmd("codeboard.revealSymbol", async (uri: vscode.Uri, line: number, end: number) => reveal(uri.fsPath, line, end));

  /** 只导航不建卡：找含这几行的卡，在几张白板上时先选白板 */
  const reveal = async (abs: string, start: number, end: number) => {
    const hits = await findOnBoards(store, abs, start, end);
    if (!hits.length) { void vscode.window.showInformationMessage("These lines are not on any board."); return; }
    let h = hits.find((x) => x.board.id === panels.target) ?? hits[0];
    const boards = [...new Map(hits.map((x) => [x.board.id, x.board])).values()];
    if (boards.length > 1) {
      const r = await vscode.window.showQuickPick(boards.map((b) => ({ label: `$(layout) ${b.name}`, description: b.id === panels.target ? "target" : undefined, b })), { placeHolder: "Reveal on which board?" });
      if (!r) return;
      h = hits.find((x) => x.board.id === r.b.id)!;
    }
    const p = await panels.show(h.board.id);
    p?.post({ type: "reveal", card: h.card.id, seg: h.seg, lines: h.lines });
  };

  cmd("codeboard.switchTarget", async () => {
    const id = await pickBoard(store, "Add to which board from the editor?", true);
    if (id) panels.setTarget(id);
  });

  // ---------- 白板管理 ----------

  cmd("codeboard.openBoard", async (a?: unknown) => {
    const id = boardArg(a) ?? (await targetId());
    await panels.show(id);
  });
  cmd("codeboard.openBoardToSide", async (a?: unknown) => {
    const id = boardArg(a);
    if (id) await panels.show(id, { side: true });
  });
  cmd("codeboard.newBoard", async (a?: unknown) => {
    const group = (a as Node)?.kind === "group" ? (a as { name: string }).name : undefined;
    const name = await vscode.window.showInputBox({ prompt: "Name of the new board", value: "New Board", placeHolder: "e.g. generate() end to end" });
    if (!name?.trim()) return;
    const b = await store.create(name.trim(), group);
    await panels.show(b.id);
  });
  cmd("codeboard.renameBoard", async (a?: unknown) => {
    const id = boardArg(a) ?? panels.target;
    const b = id && (await store.load(id));
    if (!b) return;
    const name = await vscode.window.showInputBox({ prompt: "Rename board", value: b.name });
    if (!name?.trim() || name.trim() === b.name) return;
    const p = panels.get(b.id);
    if (p?.board) {
      // 白板开着：让白板改（它持有状态，改完会存回来）
      p.post({ type: "command", name: "rename", arg: name.trim() });
      p.board.name = name.trim();
      p.panel.title = name.trim();
    }
    await store.rename(b.id, name.trim());
    await panels.pushBoards();
  });
  cmd("codeboard.duplicateBoard", async (a?: unknown) => {
    const id = boardArg(a);
    if (id) await store.duplicate(id);
  });
  cmd("codeboard.deleteBoard", async (a?: unknown) => {
    const id = boardArg(a);
    const b = id && (await store.load(id));
    if (!b) return;
    const ok = await vscode.window.showWarningMessage(`Delete board “${b.name}”?`, { modal: true, detail: `${b.cards.length} cards and their links will be removed. Your code is not affected.` }, "Delete");
    if (ok !== "Delete") return;
    panels.get(b.id)?.panel.dispose();
    await store.remove(b.id);
    if (panels.target === b.id) panels.setTarget(undefined);
    await panels.pushBoards();
  });
  cmd("codeboard.moveToGroup", async (a?: unknown) => {
    const id = boardArg(a);
    if (!id) return;
    const groups = await store.groups();
    const NONE = "(No Group)", NEW = "$(add) New Group…";
    const r = await vscode.window.showQuickPick([NONE, ...groups, NEW], { placeHolder: "Move to group" });
    if (!r) return;
    let g: string | undefined = r === NONE ? undefined : r;
    if (r === NEW) {
      g = (await vscode.window.showInputBox({ prompt: "Group name" }))?.trim();
      if (!g) return;
      await store.newGroup(g);
    }
    await store.move(id, g);
    await panels.pushBoards();
  });
  cmd("codeboard.newGroup", async () => {
    const g = (await vscode.window.showInputBox({ prompt: "Name of the new group" }))?.trim();
    if (g) await store.newGroup(g);
  });
  cmd("codeboard.renameGroup", async (a?: Node) => {
    if (a?.kind !== "group") return;
    const g = (await vscode.window.showInputBox({ prompt: "Rename group", value: a.name }))?.trim();
    if (g && g !== a.name) { await store.renameGroup(a.name, g); await panels.pushBoards(); }
  });
  cmd("codeboard.deleteGroup", async (a?: Node) => {
    if (a?.kind !== "group") return;
    const ok = await vscode.window.showWarningMessage(`Delete group “${a.name}”?`, { modal: true, detail: "Boards in it are kept and moved out of the group." }, "Delete Group");
    if (ok === "Delete Group") { await store.removeGroup(a.name); await panels.pushBoards(); }
  });
  cmd("codeboard.revealInFolder", async (a?: unknown) => {
    const id = boardArg(a);
    const f = id ? store.fileOf(id) : undefined;
    await vscode.commands.executeCommand("revealFileInOS", vscode.Uri.file(f ?? store.dir()));
  });
  cmd("codeboard.openGithubFile", async (abs: string) => {
    const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(abs));
    await vscode.window.showTextDocument(doc, { preview: true });
    await vscode.commands.executeCommand("workbench.action.files.setActiveEditorReadonlyInSession").then(undefined, () => {});
  });
}

/** 选一张白板（可以新建） */
export async function pickBoard(store: Storage, placeHolder: string, allowNew: boolean): Promise<string | undefined> {
  const metas = await store.list();
  const NEW = { label: "$(add) New Board…", id: "" };
  const items = [...metas.map((m) => ({ label: `$(layout) ${m.name}`, description: m.group, detail: undefined, id: m.id })), ...(allowNew ? [NEW] : [])];
  const r = await vscode.window.showQuickPick(items, { placeHolder });
  if (!r) return;
  if (r.id) return r.id;
  const name = await vscode.window.showInputBox({ prompt: "Name of the new board", value: "New Board" });
  return name?.trim() ? (await store.create(name.trim())).id : undefined;
}

/** 白板关着时：新卡放在已有卡片的右边，一张接一张往下排 */
export function placeCards(b: Board, cards: CodeCard[]) {
  const right = b.cards.length ? Math.max(...b.cards.map((c) => c.x + c.w)) + 80 : b.cam.x > 0 ? 80 : -b.cam.x + 80;
  let y = b.cards.length ? Math.min(...b.cards.map((c) => c.y)) : 80;
  for (const c of cards) {
    c.x = right;
    c.y = y;
    y += Math.min(600, c.segments.reduce((n, s) => n + s.text.length, 0) * 19 + 70) + 40;
    b.cards.push(c);
  }
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

export { cardTitle, boardSegments, path };
