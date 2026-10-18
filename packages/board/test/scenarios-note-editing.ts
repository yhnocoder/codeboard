// 在白板上改字：Note 的 Markdown 编辑器、Sidenote 的字、撤销。每个场景查一件事，名字就是查的那件事。
// Usage: node packages/board/test/run-harness.mjs noteImageReopens noteAutoPairOvertype noteTabStaysInEditor
import { open, put, findSym, symCard, type Host } from "./harness";
import { emptyBoard, type Board, type CodeCard, type NoteCard } from "@codeboard/core";
import type { Page } from "playwright-core";

const close = (h: Host) => h.page.context().browser()!.close();
let failed = 0;
function check(name: string, ok: boolean, info: unknown) {
  console.log(`${ok ? "PASS" : "FAIL"} ${name} ${JSON.stringify(info)}`);
  if (!ok) failed++;
}
const done = (name: string) => { const n = failed; failed = 0; if (n) throw new Error(`${name}: ${n} failed`); };

/** 打一串：{Enter}、{Control+z} 之类是按键，其余是字 */
async function keys(pg: Page, seq: string, delay = 0) {
  for (const part of seq.split(/(\{[A-Za-z0-9+]+\})/)) {
    if (!part) continue;
    if (/^\{.+\}$/.test(part)) {
      // 方向键是浏览器自己移光标，ProseMirror 要等 selectionchange 才知道：前后各等一下
      const nav = /Home|End|Arrow/.test(part);
      if (nav) await pg.waitForTimeout(300);
      await pg.keyboard.press(part.slice(1, -1));
      await pg.waitForTimeout(nav ? 120 : 30);
    } else await pg.keyboard.type(part, { delay });
  }
}
/** 一块白板：一张代码卡（Sidenote 挂在它上面）和 n 张 Note */
function board(init: string[] = []): Board {
  const b = emptyBoard("b1", "note editing");
  const s = findSym("Scheduler.schedule");
  put(b, symCard(s.f, s.s), 2400, 60, 420);
  init.forEach((md, i) => put(b, { id: `n${i}`, kind: "note", md, bg: true } as NoteCard, 60 + (i % 4) * 560, 60 + Math.floor(i / 4) * 360, 520));
  b.cam = { x: 0, y: 0, z: 1 };
  return b;
}
const md = (h: Host, id: string) => ((h.board().cards.find((c) => c.id === id) as NoteCard | undefined)?.md ?? "").trim();
const editing = (h: Host, id: string) => h.page.locator(`.card[data-id="${id}"] .md-pm`).count();
async function editNote(h: Host, id: string) {
  await h.post({ type: "reveal", card: id } as any);
  await h.page.waitForTimeout(450);
  await h.page.locator(`.card[data-id="${id}"] .nbody`).dblclick();
  await h.page.waitForSelector(`.card[data-id="${id}"] .md-pm`, { timeout: 5000 });
}
async function exitEdit(h: Host) {
  for (let k = 0; k < 3 && (await h.page.locator(".md-pm").count()); k++) { await h.page.keyboard.press("Escape"); await h.page.waitForTimeout(80); }
}
/** 每条一张 Note：打一串键、退出，最后一起看写回的 Markdown */
async function typeCases(name: string, cases: { name: string; init?: string; seq: string; md: string; delay?: number }[]) {
  const h = await open({ board: board(cases.map((c) => c.init ?? "")) });
  await h.page.waitForTimeout(1500);
  for (let i = 0; i < cases.length; i++) {
    await editNote(h, `n${i}`);
    if (cases[i].init) await keys(h.page, "{Control+End}");
    await keys(h.page, cases[i].seq, cases[i].delay);
    await h.page.waitForTimeout(150);
    await exitEdit(h);
  }
  await h.page.waitForTimeout(1500);
  cases.forEach((c, i) => check(`${name} ${c.name}`, md(h, `n${i}`) === c.md, { got: md(h, `n${i}`), want: c.md }));
  await close(h);
}

export const NOTE_EDITING: Record<string, () => Promise<void>> = {
  /** 最后一块是图片的 Note（打的、粘贴的截图）：退出以后还能再双击编辑 */
  async noteImageReopens() {
    const h = await open({ board: board(["a\n\n![i](https://x.y/a.png)", ""]) });
    await h.page.waitForTimeout(1500);
    let first = 0;
    try { await editNote(h, "n0"); first = await editing(h, "n0"); } catch { /* 打不开 */ }
    await exitEdit(h);
    await editNote(h, "n1");
    await keys(h.page, "![cat](https://x.y/c.png)");
    await exitEdit(h);
    await h.page.waitForTimeout(800);
    let again = 0;
    try { await editNote(h, "n1"); again = await editing(h, "n1"); } catch { /* 打不开 */ }
    await exitEdit(h);
    check("noteImageReopens", first === 1 && again === 1 && md(h, "n1") === "![cat](https://x.y/c.png)", { first, again, md: md(h, "n1") });
    await close(h);
    done("noteImageReopens");
  },

  /** 自动配对的右括号、引号被盖过去时，里面的链接、行内代码照常变，括号不多不少 */
  async noteAutoPairOvertype() {
    const S = ["(and [cat](http://c.at)) x", "\"[d](u)\" x", "(`c`) x", "f(g(x)) y", "($x$) z", "(x **b** y)"];
    await typeCases("noteAutoPairOvertype", [
      ...S.map((s) => ({ name: `fast ${s}`, seq: s, md: s })),
      ...S.map((s) => ({ name: `slow ${s}`, seq: s, md: s, delay: 60 })),
    ]);
    done("noteAutoPairOvertype");
  },

  /** 段落、标题里按 Tab 不离开编辑器（后面打的字照样进来）；列表里照样缩进 */
  async noteTabStaysInEditor() {
    const h = await open({ board: board(["", "", ""]) });
    await h.page.waitForTimeout(1500);
    const runs: { seq: string; want: string }[] = [{ seq: "x{Tab}y", want: "xy" }, { seq: "# h{Tab}{Shift+Tab}i", want: "# hi" }, { seq: "- a{Enter}{Tab}b", want: "- a\n  - b" }];
    const still: number[] = [];
    for (let i = 0; i < runs.length; i++) {
      await editNote(h, `n${i}`);
      await keys(h.page, runs[i].seq);
      still.push(await h.page.evaluate((id) => (document.activeElement?.closest(`.card[data-id="${id}"] .md-pm`) ? 1 : 0), `n${i}`));
      await exitEdit(h);
    }
    await h.page.waitForTimeout(1200);
    runs.forEach((r, i) => check(`noteTabStaysInEditor ${r.seq}`, still[i] === 1 && md(h, `n${i}`) === r.want, { focused: still[i], got: md(h, `n${i}`) }));
    await close(h);
    done("noteTabStaysInEditor");
  },

};
