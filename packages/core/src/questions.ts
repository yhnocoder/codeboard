// The questions on boards (question sidenotes, model.ts SidenoteQuestion), as lists. Pure functions: the host runs them on every
// stored board, a board on itself only while its question list is open (not in every frame's work).
import { baseName, cardTitle, findCard, firstLine, isCode, type Board } from "./model";

export type QuestionItem = {
  board: string;
  boardName: string;
  group?: string;
  /** the question sidenote's id */
  note: string;
  /** what it is on: a card (with its title; lines of a segment of it), a Section, or none (free on the canvas) */
  card?: string;
  title?: string;
  section?: string;
  seg?: string;
  lines?: [number, number];
  file?: string;
  md: string;
  done: boolean;
  answers: number;
  /** when it was asked */
  at: number;
};

/** The questions on a board, newest first */
export function boardQuestions(b: Board, o: { group?: string } = {}): QuestionItem[] {
  const out: QuestionItem[] = [];
  for (const n of b.sidenotes) {
    if (n.kind !== "text" || !n.q) continue;
    const it: QuestionItem = {
      board: b.id,
      boardName: b.name,
      note: n.id,
      md: n.md,
      done: !!n.q.done,
      answers: n.q.answers?.length ?? 0,
      at: n.q.at,
    };
    if (o.group) it.group = o.group;
    const at = n.at;
    if (at.section !== undefined) {
      const s = b.sections.find((x) => x.id === at.section);
      it.section = at.section;
      if (s) it.title = s.title;
    } else if (at.card !== undefined) {
      const f = findCard(b, at.card);
      if (f) {
        it.card = f.card.id;
        it.title = cardTitle(f.card, b);
        if (at.seg && at.lines && isCode(f.card)) {
          const sg = f.card.segments.find((x) => x.id === at.seg);
          if (sg?.path) it.file = baseName(sg.path);
          it.seg = at.seg;
          it.lines = [at.lines[0], at.lines[1]];
        }
      }
    }
    out.push(it);
  }
  return out.sort((x, y) => y.at - x.at);
}

/**
 * The questions on all boards. A question that goes along with a shared card is on every board with the card: it is listed once,
 * on the first of them
 */
export function collectQuestions(all: { id: string; board: Board; group?: string }[]): QuestionItem[] {
  const out: QuestionItem[] = [];
  const seen = new Set<string>();
  for (const e of all)
    for (const q of boardQuestions(e.board, { group: e.group })) {
      if (seen.has(q.note)) continue;
      seen.add(q.note);
      out.push(q);
    }
  return out;
}

/** Where a question is, as a list shows it after its first line: the file and line, the lines, or what it is on */
export function questionWhere(q: QuestionItem): string {
  const ln = q.lines ? (q.lines[0] === q.lines[1] ? `${q.lines[0]}` : `${q.lines[0]}–${q.lines[1]}`) : "";
  if (q.file) return `${q.file}:${ln}`;
  if (ln) return `${q.title ? `${q.title} · ` : ""}line${q.lines![0] === q.lines![1] ? "" : "s"} ${ln}`;
  return q.title ?? "";
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
      const ln = q.lines ? (q.lines[0] === q.lines[1] ? `${q.lines[0]}` : `${q.lines[0]}–${q.lines[1]}`) : "";
      const where = q.file ? ` (${q.file}${ln ? `:${ln}` : ""})` : ln ? ` (line ${ln})` : "";
      lines.push(`- [${q.done ? "x" : " "}] ${q.title ? `[${q.title}] ` : ""}${first.trim()}${where}`);
      for (const r of rest) lines.push(r.trim() ? `  ${r}` : "");
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

/** A question's first line, as a list row shows it */
export const questionLine = (q: Pick<QuestionItem, "md">) => firstLine(q.md) || "(no text)";
