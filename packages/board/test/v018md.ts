// v0.1.8 Markdown: static rendering on Notes / Text / descriptions / sidenotes, the WYSIWYG editor (lazy chunk), slash menu,
// bubble toolbar, [[card refs]], raw mode, task toggle on static notes (node run-harness.mjs v18md v18mdedit … [--light])
// Each scenario prints PASS / FAIL lines and throws when a check fails, so CI catches it.
import * as fs from "node:fs";
import { open, shot, symCard, findSym, put, type Host } from "./harness";
import { emptyBoard, type Board, type NoteCard } from "@codeboard/core";

const light = process.argv.includes("--light");
const card = (q: string) => { const s = findSym(q); return symCard(s.f, s.s); };
const close = (h: Host) => h.page.context().browser()!.close();
const SHOTS = process.env.MD_SHOTS ?? "/mnt/project-files/v018";

export const RICH = [
  "## block_manager.allocate",
  "",
  "prefill 时 `Scheduler.schedule()` 先调 **block_manager** 分配 KV 页，见 [nano-vllm](https://github.com/GeeeekExplorer/nano-vllm)。",
  "",
  "- [ ] check `can_allocate(seq)`",
  "- [x] 按 hash 复用前缀块",
  "  - 命中就 `ref_count += 1`",
  "",
  "| 阶段 | 每步 token |",
  "| --- | --- |",
  "| prefill | 整个 prompt |",
  "| decode | 1 |",
  "",
  "```python",
  "def allocate(self, seq):",
  "    # 先找空闲块",
  "    block = self._allocate_block(self.free_block_ids[0])",
  "    return len(seq) * 2",
  "```",
  "",
  "cost $O(n^2)$, see [[Scheduler.schedule]] and the note[^1]",
  "",
  "$$",
  "\\sum_{i=1}^{n} x_i = \\frac{a}{b}",
  "$$",
  "",
  "<details>",
  "<summary>Why __init__ is slow</summary>",
  "",
  "because __init__ builds all Blocks",
  "",
  "</details>",
  "",
  "[^1]: the footnote",
].join("\n");

export function mdBoard(): { b: Board; note: NoteCard; text: NoteCard } {
  const b = emptyBoard("b1", "v0.1.8 markdown");
  const sch = card("Scheduler.schedule");
  sch.desc = "Picks **prefill** first, then `decode`; see [[Notes on allocate]]";
  put(b, sch, 640, 60, 520);
  const note: NoteCard = { id: "n1", kind: "note", md: RICH, bg: true };
  put(b, note, 60, 60, 520);
  const text: NoteCard = { id: "t1", kind: "note", md: "# Reading notes\nTwo lines, old style\n- a list\n- with block_manager", size: "body" };
  put(b, text, 60, 900, 360);
  b.sidenotes.push({ id: "sn1", at: { card: sch.id }, kind: "text", md: "Sidenote with $x^2$ and **bold**" } as any);
  b.cam = { x: 0, y: 0, z: 0.8 };
  return { b, note, text };
}

function check(name: string, ok: boolean, info: unknown) {
  console.log(ok ? "PASS" : "FAIL", name, JSON.stringify(info));
  if (!ok) throw new Error(`${name} failed: ${JSON.stringify(info)}`);
}
async function saveShot(h: Host, name: string) {
  await shot(h, name);
  try { fs.mkdirSync(SHOTS, { recursive: true }); await h.page.screenshot({ path: `${SHOTS}/${name}.png` }); } catch { /* no project files here */ }
}

export const V018MD: Record<string, () => Promise<void>> = {
  /** Static render: math, code colours, tasks, table, chips, footnote, details; links go to the host, chips jump to the card */
  async v18md() {
    for (const theme of ["warm-ink", "ink-wash", "city"]) {
      const { b } = mdBoard();
      const h = await open({ board: b, light, w: 1400, h: 950, settings: { theme } as any });
      await h.page.waitForTimeout(500);
      const r = await h.page.evaluate(() => {
        const n = document.querySelector('.card[data-id="n1"] .nbody')!;
        const cs = (e: Element | null) => (e ? getComputedStyle(e) : null);
        return {
          katex: n.querySelectorAll(".katex").length,
          hl: n.querySelectorAll("pre.md-code .hljs-keyword").length,
          kwColor: cs(n.querySelector(".hljs-keyword"))?.color, tasks: n.querySelectorAll("li[data-type=taskItem] input").length,
          table: n.querySelectorAll("table td").length, chips: n.querySelectorAll(".cref").length, chipMissing: n.querySelectorAll(".cref.missing").length,
          fn: n.querySelectorAll("sup.fnref").length, details: n.querySelectorAll("details summary").length,
          raw: /\*\*|block\\_/.test((n as HTMLElement).innerText), under: (n as HTMLElement).innerText.includes("__init__"),
          desc: document.querySelector(".cdesc strong")?.textContent, text2: document.querySelector('.card[data-id="t1"] .tx h1')?.textContent,
        };
      });
      const ok = r.katex >= 2 && r.hl >= 2 && r.tasks === 2 && r.table === 4 && r.chips === 1 && r.chipMissing === 0 && r.fn === 1 && r.details === 1 && !r.raw && r.under && r.desc === "prefill" && r.text2 === "Reading notes";
      await saveShot(h, `v18-md-${theme}-${light ? "light" : "dark"}`);
      check(`v18md ${theme}`, ok, r);
      // 静态勾选框：改原文；点链接：交给宿主；点引用：选中那张卡
      await h.page.locator('.card[data-id="n1"] li[data-type=taskItem] input').first().click();
      await h.page.waitForTimeout(1300);
      const md = (h.board().cards.find((c) => c.id === "n1") as NoteCard).md;
      await h.page.locator('.card[data-id="n1"] a.lnk').first().click();
      await h.page.waitForTimeout(150);
      const opened = h.sent.some((m) => m.type === "openLink");
      await h.page.locator('.card[data-id="n1"] .cref').first().click();
      await h.page.waitForTimeout(700);
      const selId = await h.page.locator(".card.sel").evaluateAll((es) => es.map((e) => (e as HTMLElement).dataset.id));
      check(`v18md-click ${theme}`, opened && selId.length === 1 && selId[0] !== "n1" && md.includes("- [x] check"), { opened, selId, task: md.split("\n")[4] });
      await close(h);
    }
  },
};
