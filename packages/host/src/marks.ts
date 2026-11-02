import { allCodeCards, type Segment } from "@codeboard/core";
import { analysisOf, treeAt } from "./analysis";
import type { Storage } from "./storage/boards";
import { workingPlace } from "./versions";
import type { HostContext } from "./context";

type Entry = { board: string; card: string; seg: Segment };
/** 一个 CodeLens：line 从 1 开始；args 是命令参数 */
export type Lens = { line: number; title: string; tooltip: string; command: string; args: unknown[] };

export class BoardMarks {
  private byFile = new Map<string, Entry[]>();

  constructor(private cx: HostContext) {}

  async rebuild(store: Storage) {
    const m = new Map<string, Entry[]>();
    for (const { board } of await store.all()) {
      for (const c of allCodeCards(board))
        for (const s of c.segments) {
          const abs = s.src.kind === "free" ? null : this.cx.sources.absOf(s);
          if (abs) (m.get(abs) ?? m.set(abs, []).get(abs)!).push({ board: board.id, card: c.id, seg: s });
        }
    }
    this.byFile = m;
  }

  /** 目标白板上有的行（工作区里现在的位置）：[开始, 结束]，从 1 开始 */
  async lines(abs: string, target: string | undefined): Promise<[number, number][]> {
    const out: [number, number][] = [];
    for (const e of (this.byFile.get(abs) ?? []).filter((x) => x.board === target)) {
      const wp = await workingPlace(this.cx, e.seg);
      if (wp) out.push([wp.start, wp.end]);
    }
    return out;
  }

  /** 文件里在白板上的函数 / 类：不在目标白板上的加「+ Card」，都加「on N boards」 */
  lenses(abs: string, lang: string, text: () => string, target: string | undefined): Lens[] {
    const ents = this.byFile.get(abs);
    if (!ents?.length) return [];
    const out: Lens[] = [];
    for (const s of analysisOf(lang, text(), treeAt(this.cx, abs)).symbols) {
      const on = ents.filter((e) => e.seg.symbol?.qual === s.qual);
      if (!on.length) continue;
      const boards = new Set(on.map((e) => e.board));
      if (!boards.has(target ?? ""))
        out.push({
          line: s.defLine,
          title: "+ Card",
          tooltip: "Add to the target board",
          command: "codeboard.addSymbol",
          args: [abs, s.qual],
        });
      out.push({
        line: s.defLine,
        title: `on ${boards.size} board${boards.size > 1 ? "s" : ""}`,
        tooltip: "Reveal on Board",
        command: "codeboard.revealSymbol",
        args: [abs, s.start, s.end],
      });
    }
    return out;
  }
}
