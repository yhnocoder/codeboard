import { describe, expect, it } from "vitest";
import {
  emptyBoard,
  boardQuestions,
  collectQuestions,
  questionsMarkdown,
  questionWhere,
  exportOrder,
  boardMarkdown,
  githubPermalink,
  segPermalink,
  inlineSnapshot,
  removeCards,
  renameCard,
  cardTitle,
  type Board,
  type Card,
  type CodeCard,
} from "../src";

const code = (id: string, path: string, text: string[], start = 10): CodeCard => ({
  id,
  kind: "code",
  segments: [
    {
      id: `s${id}`,
      src: { kind: "repo", repo: "" },
      path,
      lang: "python",
      start,
      end: start + text.length - 1,
      text,
      version: { kind: "git", commit: "bb823b3c0ffee12" },
      symbol: { qual: id, kind: "function" },
    },
  ],
});
const note = (id: string, md: string): Card => ({ id, kind: "note", md, look: "note" });
function board(id: string, name: string, cards: Card[], at: Record<string, [number, number]> = {}): Board {
  const b = { ...emptyBoard(id, name), cards };
  cards.forEach((c, i) => {
    const p = at[c.id] ?? [i * 600, 0];
    b.place[c.id] = { x: p[0], y: p[1], w: 500 };
  });
  return b;
}

describe("questions", () => {
  it("lists question sidenotes newest first, with their card, lines or Section; follows a renamed card", () => {
    const b = board("b", "nano-vllm · Scheduler", [
      code("BlockManager.allocate", "nanovllm/engine/block_manager.py", ["a", "b", "c"], 59),
      note("n", "prefix caching 是一条链"),
    ]);
    b.sections.push({ id: "S", title: "Prefill", x: 0, y: 0, w: 10, h: 10 });
    const at = { card: "BlockManager.allocate", seg: "sBlockManager.allocate", lines: [61, 61] as [number, number] };
    b.sidenotes.push(
      { id: "q1", kind: "text", md: "为什么 hash 要把前一块的 h 也算进去？", at, q: { at: 1 } },
      {
        id: "q2",
        kind: "text",
        md: "cache_miss?",
        at,
        q: { at: 3, done: true, answers: [{ id: "a", md: "x", at: 4 }] },
      },
      { id: "q3", kind: "text", md: "free?", at: { x: 0, y: 0 }, q: { at: 2 } },
      { id: "q4", kind: "text", md: "this stage?", at: { section: "S" }, q: { at: 0 } },
      { id: "n1", kind: "text", md: "not a question", at: { card: "n" } },
    );
    const qs = boardQuestions(b);
    expect(qs.map((q) => [q.note, q.lines?.[0], q.done, q.answers])).toEqual([
      ["q2", 61, true, 1],
      ["q3", undefined, false, 0],
      ["q1", 61, false, 0],
      ["q4", undefined, false, 0],
    ]);
    expect(qs[0]).toMatchObject({ file: "block_manager.py", title: "BlockManager.allocate" });
    expect(qs[3]).toMatchObject({ section: "S", title: "Prefill" });
    expect(questionWhere(qs[0])).toBe("block_manager.py:61");
    expect(questionWhere(qs[3])).toBe("Prefill");
    renameCard(b, "BlockManager.allocate", "c2");
    expect(boardQuestions(b)[0].card).toBe("c2");
    removeCards(b, ["c2"]);
    expect(boardQuestions(b).map((q) => q.note)).toEqual(["q3", "q4"]);
  });

  it("lists a question that goes along with a shared card once across boards, and writes a checklist without escaping identifiers", () => {
    const mk = (id: string, name: string, note: string) => {
      const b = board(id, name, [code("r", "a/block_manager.py", ["x"], 61)]);
      b.sidenotes.push({
        id: note,
        kind: "text",
        md: "why block_manager.allocate?\nsecond line",
        at: { card: "r", seg: "sr", lines: [61, 61] },
        q: { at: 1 },
      });
      return b;
    };
    const all = collectQuestions([
      { id: "A", board: mk("A", "Attention", "q") },
      { id: "M", board: mk("M", "MoE", "q") },
      { id: "C", board: mk("C", "Copy", "q2") },
    ]);
    expect(all.map((q) => q.board)).toEqual(["A", "C"]);
    const md = questionsMarkdown(all);
    expect(md).toContain("## Attention");
    expect(md).toContain("- [ ] [r] why block_manager.allocate? (block_manager.py:61)\n  second line");
    expect(md).not.toContain("\\_");
  });
});

describe("export", () => {
  const nano = () => {
    const sch = code(
      "Scheduler.schedule",
      "nanovllm/engine/scheduler.py",
      ["def schedule(self):", "    # hidden", "    # hidden", "    return self.block_manager.can_allocate(seq)"],
      24,
    );
    sch.segments[0].hidden = [[25, 26]];
    const can = code(
      "BlockManager.can_allocate",
      "nanovllm/engine/block_manager.py",
      ["def can_allocate(self, seq):", "    return len(self.free_block_ids) >= seq.num_blocks"],
      40,
    );
    const n = note("n", "Notes on block_manager and __init__: $O(n)$");
    const lone = note("lone", "far away");
    const b = board("b", "Scheduler", [sch, can, n, lone], {
      "Scheduler.schedule": [0, 0],
      "BlockManager.can_allocate": [700, 0],
      n: [0, 500],
      lone: [0, 2000],
    });
    b.links.push({
      id: "l1",
      from: { card: sch.id, seg: sch.segments[0].id, line: 27 },
      to: { card: can.id },
      call: { name: "can_allocate", col: 0 },
    });
    b.links.push({ id: "l2", from: { card: can.id }, to: { card: "n" }, label: "see" });
    b.sidenotes.push({
      id: "sn1",
      kind: "text",
      at: { card: sch.id, seg: sch.segments[0].id, lines: [27, 27] },
      md: "先 prefill 再 decode",
    });
    b.sidenotes.push({ id: "sn2", kind: "text", at: { card: sch.id }, md: "private", boardOnly: true });
    b.sidenotes.push({
      id: "q",
      kind: "text",
      at: { card: can.id, seg: can.segments[0].id, lines: [41, 41] },
      md: "why >=?",
      q: { at: 1, answers: [{ id: "a", md: "free ids", at: 2 }] },
    });
    b.sections.push({ id: "S", title: "S", x: -20, y: 400, w: 600, h: 300 });
    b.place.n.section = "S";
    return b;
  };

  it("orders cards by walkthrough, then the rest by position; sections and one path", () => {
    const b = nano();
    expect(exportOrder(b, { kind: "board" })).toEqual(["Scheduler.schedule", "BlockManager.can_allocate", "n", "lone"]);
    expect(exportOrder(b, { kind: "sections", ids: ["S"] })).toEqual(["n"]);
    expect(exportOrder(b, { kind: "walk", start: "BlockManager.can_allocate" })).toEqual([
      "BlockManager.can_allocate",
      "n",
    ]);
  });

  it("writes Markdown with path#lines, commit, permalink, sidenotes, questions on demand and arrows; identifiers stay unescaped", () => {
    const b = nano();
    const md = boardMarkdown(b, {
      order: exportOrder(b, { kind: "board" }),
      links: { "sScheduler.schedule": "https://github.com/x/nano-vllm/blob/bb8/s.py#L24-L27" },
    });
    expect(md).toContain(
      "## A · Scheduler.schedule\n\n`nanovllm/engine/scheduler.py#L24-L27` · bb823b3 · [permalink](https://github.com/x/nano-vllm/blob/bb8/s.py#L24-L27)\n\n```python\ndef schedule(self):\n    ⋯ 2 hidden lines\n    return self.block_manager.can_allocate(seq)\n```",
    );
    expect(md).toContain("> **Sidenote** · line 27\n>\n> 先 prefill 再 decode");
    expect(md).toContain("→ BlockManager.can_allocate · from line 27 · calls can_allocate()");
    expect(md).toContain("→ Notes on block_manager and __init__: $O(n)$ · “see”");
    expect(md).toContain("Notes on block_manager and __init__: $O(n)$");
    expect(md).not.toContain("\\_");
    expect(md).not.toContain("private");
    expect(md).not.toContain("why >=?");
    const all = boardMarkdown(b, { order: ["BlockManager.can_allocate"], questions: true, boardOnly: true });
    expect(all).toContain("- [ ] **Question** (line 41): why >=?\n  - free ids");
    expect(boardMarkdown(b, { order: ["Scheduler.schedule"], boardOnly: true })).toContain("private");
  });

  it("keeps a Note image's caption in the placeholder and drops its width", () => {
    const b = board("b", "imgs", [
      note("n", 'x\n\n![warp](assets/a-1x1.png "Fig. 1: \\"if\\" paths"){width=40%}\n\n![](assets/b-1x1.png)'),
    ]);
    const md = boardMarkdown(b, { order: ["n"] });
    expect(md).toContain('*Image: warp — Fig. 1: "if" paths*');
    expect(md).not.toContain("width=");
    expect(md).toContain("\n*Image*");
  });
  it("writes a Note's pasted images (stored in assets/) as placeholders, like Image cards; web images stay", () => {
    const b = board("b", "imgs", [
      note(
        "n",
        'shot ![screen](assets/0123456789abcdef-640x480.png) and ![](assets/a-1x1.gif "t")\n\n![w](https://a.b/c.png)',
      ),
    ]);
    const md = boardMarkdown(b, { order: ["n"] });
    expect(md).toContain("shot *Image: screen* and *Image: t*"); // the title is the image's caption
    expect(md).toContain("![w](https://a.b/c.png)");
    expect(md).not.toContain("assets/");
    expect(md).toContain("## shot screen and");
    // a Note that starts with a pasted screenshot is titled by its first line of text
    expect(cardTitle(note("p", "![](assets/0123456789abcdef-1x1.png)\n\nScheduler flow"))).toBe("Scheduler flow");
  });

  it("builds GitHub permalinks and inlines snapshot resources", async () => {
    expect(githubPermalink("git@github.com:GeeeekExplorer/nano-vllm.git", "bb823b3", "nanovllm/a b.py", 3, 9)).toBe(
      "https://github.com/GeeeekExplorer/nano-vllm/blob/bb823b3/nanovllm/a%20b.py#L3-L9",
    );
    expect(githubPermalink("https://gitlab.com/x/y", "bb823b3", "a.py", 1, 1)).toBeUndefined();
    const s = code("f", "a.py", ["x"], 5).segments[0];
    expect(segPermalink(s, () => "https://github.com/o/n")).toBe("https://github.com/o/n/blob/bb823b3c0ffee12/a.py#L5");
    expect(segPermalink({ ...s, src: { kind: "github", owner: "o", name: "n", ref: "main" } })).toBe(
      "https://github.com/o/n/blob/bb823b3c0ffee12/a.py#L5",
    );
    const seen: string[] = [];
    const html = await inlineSnapshot(
      `<style>@font-face{src:url(cbres:media/fonts/A.woff2)}</style><img src="cbres:asset/x.png"><img src="cbres:asset/x.png"><img src="cbres:asset/missing.png">`,
      async (k, p) => {
        seen.push(`${k}:${p}`);
        return p === "missing.png" ? null : { mime: "image/png", base64: "QQ==" };
      },
    );
    expect(html).toBe(
      `<style>@font-face{src:url(data:image/png;base64,QQ==)}</style><img src="data:image/png;base64,QQ=="><img src="data:image/png;base64,QQ=="><img src="">`,
    );
    expect(seen).toEqual(["media:fonts/A.woff2", "asset:x.png", "asset:missing.png"]);
  });

  it("ends a reference at an escaped quote, as in an element's style attribute", async () => {
    const html = await inlineSnapshot(
      `<div style="background: url(&quot;cbres:asset/x.png&quot;)"></div>`,
      async () => ({
        mime: "image/png",
        base64: "QQ==",
      }),
    );
    expect(html).toBe(`<div style="background: url(&quot;data:image/png;base64,QQ==&quot;)"></div>`);
  });
});
