// 宿主的命令（makeActions 做的事）在编辑器里叫什么：命令面板和菜单里的名字、图标。VS Code 插件的 package.json（contributes.commands）
// 由它生成（extensions/vscode/src/contributes.ts）。hidden = 只给侧栏、CodeLens、快捷键或测试调用，不进命令列表

/** 命令的图标（编辑器的壳换成自己的图标，比如 VS Code 的 codicon） */
export type CommandIcon = "window" | "add" | "newFolder" | "edit" | "close";
export type CommandDecl = { title: string; icon?: CommandIcon; hidden?: true };

export const COMMANDS = {
  "codeboard.openBoard": { title: "Open Board", icon: "window" },
  "codeboard.setDeepseekKey": { title: "Set DeepSeek API Key" },
  "codeboard.clearDeepseekKey": { title: "Clear DeepSeek API Key" },
  "codeboard.openBoardToSide": { title: "Open to the Side" },
  "codeboard.newBoard": { title: "New Board", icon: "add" },
  "codeboard.newGroup": { title: "New Group", icon: "newFolder" },
  "codeboard.renameBoard": { title: "Rename Board", icon: "edit" },
  "codeboard.duplicateBoard": { title: "Duplicate Board" },
  "codeboard.deleteBoard": { title: "Delete Board", icon: "close" },
  "codeboard.moveToGroup": { title: "Move to Group…" },
  "codeboard.copyToProject": { title: "Copy to Another Project…" },
  "codeboard.moveToProject": { title: "Move to Another Project…" },
  "codeboard.moveBoardsIntoProject": { title: "Move Boards into Project…" },
  "codeboard.exportBoards": { title: "Export Boards…" },
  "codeboard.importBoards": { title: "Import Boards…" },
  "codeboard.revealInFolder": { title: "Reveal in Folder" },
  "codeboard.renameGroup": { title: "Rename Group", icon: "edit" },
  "codeboard.deleteGroup": { title: "Delete Group", icon: "close" },
  "codeboard.addToBoard": { title: "Add to Board" },
  "codeboard.addSeparateCards": { title: "Add Selection as Separate Cards" },
  "codeboard.undoAdd": { title: "Undo Add to Board" },
  "codeboard.addToAnotherBoard": { title: "Add to Another Board…" },
  "codeboard.addToSelectedCard": { title: "Add to Selected Card" },
  "codeboard.addFunction": { title: "Add Function at Cursor" },
  "codeboard.addSidenote": { title: "Add as Sidenote" },
  "codeboard.revealOnBoard": { title: "Reveal on Board" },
  "codeboard.switchTarget": { title: "Switch Target Board" },
  "codeboard.addSymbol": { title: "Add Symbol to Board" },
  "codeboard.revealSymbol": { title: "Reveal Symbol on Board" },
  "codeboard.openGithubFile": { title: "Open GitHub File" },
  "codeboard.addGithubRepo": { title: "Add Repo…", icon: "add" },
  "codeboard.boardKey": { title: "Board Shortcut" },
  "codeboard.openSettings": { title: "Open Settings" },
  "codeboard.copyDiagnostics": { title: "Copy Diagnostics" },
  "codeboard.captureRun": { title: "Capture Run…" },
  "codeboard.applyRun": { title: "Apply Run…" },
  "codeboard.openQuestion": { title: "Open Question" },
  "codeboard.openBrokenBoard": { title: "Open Broken Board", hidden: true },
  // 共享卡还没有界面：测试用的入口
  "codeboard._shareCards": { title: "Share Cards", hidden: true },
  "codeboard._unshareCard": { title: "Unshare Card", hidden: true },
} as const satisfies Record<string, CommandDecl>;

export type CommandId = keyof typeof COMMANDS;
