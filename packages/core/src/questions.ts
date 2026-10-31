// 纯函数：宿主拿卡库里的所有白板算；白板只在面板开着时算自己这一块（不进每帧的工作）。
import { baseName, cardTitle, isCode, isQuestion, findCard, stickerWhere, type Board } from "./model";

export type QuestionItem = {
  board: string;
  boardName: string;
  group?: string;
  sticker: string;
  /** 贴在哪张卡上（行、绑在卡上；绑在箭头上的算箭头出发的卡）；画布上的没有 */
  card?: string;
  title?: string;
  seg?: string;
  line?: number;
  file?: string;
  md: string;
  done: boolean;
  answer?: string;
  answerTitle?: string;
  at?: number;
};

/** 一块白板上的问题（按卡的叠放顺序，同一张卡按行号） */
export function boardQuestions(b: Board, o: { group?: string } = {}): QuestionItem[] {
  const out: QuestionItem[] = [];
  for (const s of b.stickers) {
    if (!isQuestion(s)) continue;
    const w = stickerWhere(b, s);
    const f = w.card ? findCard(b, w.card) : undefined;
    const it: QuestionItem = { board: b.id, boardName: b.name, sticker: s.id, md: s.q?.md ?? "", done: !!s.q?.done };
    if (o.group) it.group = o.group;
    if (f) {
      it.card = f.card.id;
      it.title = cardTitle(f.card, b);
      if (w.seg && isCode(f.card)) {
        const sg = f.card.segments.find((x) => x.id === w.seg);
        if (sg?.path) it.file = baseName(sg.path);
        it.seg = w.seg;
      }
      if (w.line !== undefined) it.line = w.line;
    }
    const a = s.q?.answer ? findCard(b, s.q.answer) : undefined;
    if (a) {
      it.answer = a.card.id;
      it.answerTitle = cardTitle(a.card, b);
    }
    if (s.q?.at) it.at = s.q.at;
    out.push(it);
  }
  const rank = new Map(b.cards.map((c, i) => [c.id, i]));
  return out.sort(
    (x, y) => (rank.get(x.card ?? "") ?? 1e9) - (rank.get(y.card ?? "") ?? 1e9) || (x.line ?? 0) - (y.line ?? 0),
  );
}

/**
 * 所有白板的问题。共享卡出现在几块白板上：复制出来的白板会带着同一个贴纸 id，同一张共享卡上同一个贴纸只列一次（列在先出现的那块白板）
 */
export function collectQuestions(
  all: { id: string; board: Board; group?: string; refs?: ReadonlySet<string> }[],
): QuestionItem[] {
  const out: QuestionItem[] = [];
  const seen = new Set<string>();
  for (const e of all)
    for (const q of boardQuestions(e.board, { group: e.group })) {
      if (q.card && e.refs?.has(q.card)) {
        const k = `${q.card}\0${q.sticker}`;
        if (seen.has(k)) continue;
        seen.add(k);
      }
      out.push(q);
    }
  return out;
}

/**
 * Markdown 清单：- [ ] [卡] 问题 (file.py:61)；解决了的是 - [x]。几块白板时按白板分组（## 白板名）。
 * 问题有好几行时第一行跟在勾选框后面，其余缩进两格接在下面
 */
export function questionsMarkdown(items: QuestionItem[], o: { title?: string } = {}): string {
  const lines: string[] = [];
  if (o.title) lines.push(`# ${o.title}`, "");
  const boards = [...new Set(items.map((q) => q.board))];
  for (const id of boards) {
    const qs = items.filter((q) => q.board === id);
    if (boards.length > 1) lines.push(`## ${qs[0].boardName}`, "");
    for (const q of qs) {
      const [first, ...rest] = (q.md.trim() || "(no text)").split("\n");
      const where = q.file
        ? ` (${q.file}${q.line !== undefined ? `:${q.line}` : ""})`
        : q.line !== undefined
          ? ` (line ${q.line})`
          : "";
      lines.push(`- [${q.done ? "x" : " "}] ${q.title ? `[${q.title}] ` : ""}${first.trim()}${where}`);
      for (const r of rest) lines.push(r.trim() ? `  ${r}` : "");
      if (q.done && q.answerTitle) lines.push(`  Answered by “${q.answerTitle}”`);
    }
    lines.push("");
  }
  return (
    lines
      .join("\n")
      .replace(/\n{3,}/g, "\n\n")
      .trimEnd() + "\n"
  );
}
