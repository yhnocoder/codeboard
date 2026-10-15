import type { Board, BoardMeta, CardView, CodeCard } from "./model";
import type { DiffLine } from "./diff";

/** 新建代码卡片时宿主给出的内容，位置由白板决定 */
export type NewCodeCard = Omit<CodeCard, "id" | "x" | "y" | "w" | "hl">;

export type HostToBoard =
  | { type: "load"; board: Board; boards: BoardMeta[]; views: Record<string, CardView> }
  | { type: "views"; views: Record<string, CardView> }
  | { type: "addCode"; card: NewCodeCard; view: CardView; from?: { card: string; line: number } }
  | { type: "followed"; id: string; patch: Pick<CodeCard, "start" | "end" | "snapshot" | "commit" | "dirty">; lineMap: Record<number, number>; view: CardView }
  | { type: "diff"; id: string; lines: DiffLine[]; from: string; to: string }
  | { type: "focusCard"; id: string }
  | { type: "toast"; text: string };

export type BoardToHost =
  | { type: "ready" }
  | { type: "save"; board: Board }
  | { type: "openCode"; id: string; line?: number }
  | { type: "expand"; id: string; line: number; name: string; recv?: string; col: number }
  | { type: "requestDiff"; id: string }
  | { type: "follow"; id: string }
  | { type: "pickCode" } // 让宿主帮忙选一段代码（打开快速选择）
  | { type: "switchBoard"; id: string }
  | { type: "newBoard" }
  | { type: "openLink"; url: string };
