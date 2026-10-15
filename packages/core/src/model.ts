// 白板的持久化数据模型。宿主（VS Code、将来的 Electron）和白板界面共用。

export type EdgeKind = "call" | "seq" | "data" | "loop";

type Base = { id: string; x: number; y: number; w: number };

/** 代码卡片：锚定到某个文件的一段代码，并记下建卡时的快照 */
export type CodeCard = Base & {
  type: "code";
  path: string; // 相对工作区根目录
  start: number; // 1-based，含
  end: number; // 1-based，含
  lang: string; // VS Code languageId，如 python、cpp
  snapshot: string[]; // 建卡（或最近一次跟进）时的代码行
  commit: string | null; // 快照对应的 commit；null 表示不在 git 里
  dirty?: boolean; // 建卡时这段代码有未提交的改动
  symbol?: string; // 有符号就按符号同步，如 Scheduler.schedule
  title?: string; // 没有符号时的显示名
  hl: number[]; // 显式高亮的行（文件行号）
  step?: string; // 讲解顺序编号，如 "2.1"
  collapsed?: boolean;
  io?: string; // 折叠时显示的输入输出摘要，阶段二由追踪填充
  note?: string; // 卡片底部的一句批注
};
export type NoteCard = Base & { type: "note"; text: string; tone?: "plain" | "question" };
export type ImageCard = Base & { type: "image"; src: string; caption?: string };
export type LinkCard = Base & { type: "link"; url: string; title: string; desc?: string };
export type GroupCard = Base & { type: "group"; h: number; label: string };
export type Card = CodeCard | NoteCard | ImageCard | LinkCard | GroupCard;

export type Edge = {
  id: string;
  from: { card: string; line?: number };
  to: { card: string };
  kind: EdgeKind;
  label?: string; // 阶段二：追踪到的值摘要也写在这里
};

export type Camera = { x: number; y: number; z: number };
export type Board = { id: string; name: string; cards: Card[]; edges: Edge[]; cam: Camera; version: 1 };
export type BoardMeta = { id: string; name: string };

export function emptyBoard(id: string, name: string): Board {
  return { id, name, cards: [], edges: [], cam: { x: 120, y: 120, z: 1 }, version: 1 };
}

/** 代码卡片和工作区当前代码的关系 */
export type Sync =
  | { state: "ok" }
  | { state: "moved"; start: number; end: number }
  | { state: "changed"; start: number; end: number; added: number; removed: number }
  | { state: "lost" }
  | { state: "unknown" }; // 文件读不到（比如工作区换了）

/** 宿主为每张代码卡片算好的展示数据，不持久化 */
export type CardView = {
  html: string[]; // 每行高亮后的 HTML
  calls: CallSpan[]; // 可以点击展开的调用
  sync: Sync;
};
export type CallSpan = { line: number; start: number; end: number; name: string; recv?: string };
