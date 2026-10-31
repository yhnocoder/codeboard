// package.json 的 contributes.commands 和 contributes.configuration：从宿主的命令表（COMMANDS）和 core 的设置声明（settingsSchema）生成，
// 加上只有 VS Code 插件才有的几项（侧栏问题列表的命令、CodeLens 的设置）。npm run build 写进 package.json，test/package.test.ts 比对
import { settingsSchema, type SettingSchema } from "@codeboard/core/settings";
import { COMMANDS, type CommandDecl, type CommandIcon } from "@codeboard/host";

const CODICON: Record<CommandIcon, string> = {
  window: "window",
  add: "add",
  newFolder: "new-folder",
  edit: "edit",
  close: "close",
};
/** 命令要开着的条件（VS Code 的 when 子句；codeboard.canUndoAdd 由 Workspace.ui.undoAddKey 设） */
const ENABLEMENT: Record<string, string> = { "codeboard.undoAdd": "codeboard.canUndoAdd" };

type Command = { command: string; title: string; category: "CodeBoard"; icon?: string; enablement?: string };
const command = (id: string, d: CommandDecl): Command => ({
  command: id,
  title: d.title,
  category: "CodeBoard",
  ...(d.icon && { icon: `$(${CODICON[d.icon]})` }),
  ...(ENABLEMENT[id] && { enablement: ENABLEMENT[id] }),
});

/** 侧栏 Questions 列表自己的命令（sidebar.ts 的 QuestionTree） */
const SIDEBAR_COMMANDS: Command[] = [
  { command: "codeboard.questions.showAll", title: "Show All Questions", category: "CodeBoard", icon: "$(list-flat)" },
  {
    command: "codeboard.questions.showOpen",
    title: "Show Open Questions Only",
    category: "CodeBoard",
    icon: "$(filter-filled)",
  },
  { command: "codeboard.copyQuestions", title: "Copy Questions as List", category: "CodeBoard", icon: "$(copy)" },
];

/** CodeLens 和行号旁的标记（lens.ts、marks） */
const EDITOR_MARKS: SettingSchema = {
  type: "string",
  default: "all",
  enum: ["all", "lens", "off"],
  enumDescriptions: [
    'The "on N boards" / "+ Card" CodeLens above functions and classes, plus the orange bar next to the line numbers and its mark in the overview ruler for lines on the target board.',
    "Only the CodeLens: no bar next to the line numbers and no overview ruler mark.",
    "No CodeBoard marks in file editors.",
  ],
  description: "What CodeBoard shows in file editors for code that is on a board. Applies right away.",
};

export function contributes() {
  const commands = (Object.entries(COMMANDS) as [string, CommandDecl][])
    .filter(([, d]) => !d.hidden)
    .map(([id, d]) => command(id, d));
  return {
    commands: [...commands, ...SIDEBAR_COMMANDS],
    configuration: { title: "CodeBoard", properties: { ...settingsSchema(), "codeboard.editorMarks": EDITOR_MARKS } },
  };
}
