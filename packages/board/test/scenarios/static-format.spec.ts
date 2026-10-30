// Bold and Highlight without entering edit mode: with one Note selected, drag-select a phrase in its static body; a small toolbar
// (the editor's selection toolbar look) shows over it, and its buttons, ⌘B and ⇧⌘H change the Markdown source directly (one undo
// step each), leaving the same text selected so the other one can follow.
// Usage: npm run harness -- staticSelectionBoldHighlight
import { emptyBoard, type Board, type NoteCard } from "@codeboard/core";
import type { Page } from "playwright-core";
import { put, shot } from "../harness";
import { test, open, check, light, until, idle } from "../fixtures";

const PHRASE = "brave charlie";
const PLAIN = "## Plan\n\nalpha brave charlie delta echo\n\n* keep\n* this";

function board(): Board {
  const b = emptyBoard("b1", "static format");
  put(b, { id: "n0", kind: "note", md: PLAIN, look: "note" } as NoteCard, 80, 80, 380);
  b.cam = { x: 0, y: 0, z: 1 };
  return b;
}

/** Drag across `word` in the Note's static body, the way a person selects it */
async function dragSelect(pg: Page, word: string) {
  const r = await pg.evaluate((word) => {
    const root = document.querySelector('.card[data-id="n0"] .nbody')!;
    const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let t = w.nextNode() as Text | null; t; t = w.nextNode() as Text | null) {
      const i = t.data.indexOf(word);
      if (i < 0) continue;
      const rg = document.createRange();
      rg.setStart(t, i); rg.setEnd(t, i + 1);
      const a = rg.getBoundingClientRect();
      rg.setStart(t, i + word.length - 1); rg.setEnd(t, i + word.length);
      const b = rg.getBoundingClientRect();
      return { x0: a.left + 1, x1: b.right - 1, y: (a.top + a.bottom) / 2 };
    }
    return null;
  }, word);
  if (!r) throw new Error(`"${word}" is not in the Note`);
  await pg.mouse.move(r.x0, r.y);
  await pg.mouse.down();
  await pg.mouse.move(r.x1, r.y, { steps: 6 });
  await pg.mouse.up();
}

test("staticSelectionBoldHighlight", async () => {
  const h = await open({ board: board(), light, w: 1000, h: 700, settings: { theme: "warm-ink" } as never });
  const pg = h.page;
  await idle(h);
  const md = () => (h.board().cards.find((c) => c.id === "n0") as NoteCard).md;
  const view = () => pg.evaluate(() => {
    const body = document.querySelector('.card[data-id="n0"] .nbody')!;
    return {
      sel: getSelection()?.toString() ?? "",
      strong: [...body.querySelectorAll("strong")].map((e) => e.textContent).join("|"),
      mark: [...body.querySelectorAll("mark")].map((e) => e.textContent).join("|"),
      editing: !!document.querySelector(".card[data-id=\"n0\"] .editing"),
      pressed: [...document.querySelectorAll<HTMLElement>(".md-bubble .tbtn")].map((b) => `${b.dataset.tip}:${b.getAttribute("aria-pressed")}`).join(" "),
    };
  });
  /** wait until the host has `want`, then report what the board shows */
  const saved = async (what: string, want: string) => {
    const ok = await until(h, what, () => md() === want).catch(() => false);
    await idle(h);
    return { ok, md: md(), ...(await view()) };
  };

  await pg.locator('.card[data-id="n0"] .chead').first().click({ position: { x: 30, y: 10 } });
  await until(h, "n0 selected alone", () => pg.evaluate(() => [...document.querySelectorAll<HTMLElement>(".card.sel[data-id]")].map((e) => e.dataset.id).join() === "n0"));
  await idle(h);
  await dragSelect(pg, PHRASE);
  const bar = await until(h, "the toolbar over the static selection", () => pg.evaluate(() => !!document.querySelector(".md-bubble"))).catch(() => false);
  const tb = await pg.evaluate(() => {
    const b = document.querySelector(".md-bubble")?.getBoundingClientRect(), r = getSelection()!.rangeCount ? getSelection()!.getRangeAt(0).getBoundingClientRect() : null;
    return { tips: [...document.querySelectorAll<HTMLElement>(".md-bubble .tbtn")].map((e) => e.dataset.tip).join(","), above: !!b && !!r && b.bottom <= r.top + 1 && b.right > r.left && b.left < r.right };
  });
  await shot(h, "staticSelectionBoldHighlight-toolbar");
  check("staticSelectionToolbarShows", bar && tb.tips === "Bold,Highlight" && tb.above, tb, await view());
  if (!bar) { await h.close(); return; }

  await pg.locator('.md-bubble .tbtn[data-tip="Bold"]').click();
  const BOLD = PLAIN.replace(PHRASE, `**${PHRASE}**`);
  const b1 = await saved("Bold reaches the host", BOLD);
  check("staticSelectionBold", b1.ok && b1.strong === PHRASE && b1.sel === PHRASE && !b1.editing && b1.pressed === "Bold:true Highlight:false", b1);

  await pg.locator('.md-bubble .tbtn[data-tip="Highlight"]').click();
  const both = await until(h, "Highlight reaches the host", () => md().includes("==") && md()).catch(() => md());
  await idle(h);
  const b2 = await view();
  check("staticSelectionHighlight", /alpha (==\*\*brave charlie\*\*==|\*\*==brave charlie==\*\*) delta echo/.test(both) && both.endsWith("* keep\n* this") && b2.mark === PHRASE && b2.strong === PHRASE && b2.sel === PHRASE && !b2.editing && b2.pressed === "Bold:true Highlight:true", { md: both, ...b2 });
  await shot(h, "staticSelectionBoldHighlight-both");

  // Toggling off from the keyboard: the whole selection is bold, then highlighted, so each comes off again
  await pg.keyboard.press("Control+b");
  const HL = PLAIN.replace(PHRASE, `==${PHRASE}==`);
  const b3 = await saved("⌘B takes the bold off", HL);
  check("staticSelectionBoldOff", b3.ok && b3.strong === "" && b3.mark === PHRASE && b3.sel === PHRASE && !b3.editing, b3);
  await pg.keyboard.press("Control+Shift+H");
  const b4 = await saved("⇧⌘H takes the highlight off", PLAIN);
  check("staticSelectionHighlightOff", b4.ok && b4.mark === "" && b4.sel === PHRASE && !b4.editing, b4);

  await pg.keyboard.press("Control+z");
  const b5 = await saved("one undo brings the highlight back", HL);
  check("staticSelectionUndoOneStep", b5.ok, b5);
  await h.close();
});

/** A selection that wraps onto the next line: the toolbar sits over the selected part of the first line, not over the middle of the paragraph */
test("staticToolbarOverFirstLine", async () => {
  const b = emptyBoard("b1", "static format wrap");
  const long = "横轴是以 FLOP/B 表示的算术强度或计算强度，反映应用每加载一个字节数据所完成的工作量；纵轴是以 GFLOPS 表示的计算吞吐量。图中的两条线表示硬件限制。";
  put(b, { id: "n0", kind: "note", md: `## Roofline\n\n${long}`, look: "note" } as NoteCard, 80, 80, 520);
  b.cam = { x: 0, y: 0, z: 1 };
  const h = await open({ board: b, light });
  const pg = h.page;
  await pg.locator('.card[data-id="n0"]').click({ position: { x: 20, y: 12 } });
  await idle(h);
  // 从第一行靠右的「每加载」选到第二行的「工作量」
  const lines = await pg.evaluate(() => {
    const root = document.querySelector('.card[data-id="n0"] .nbody p')!;
    const t = root.firstChild as Text, i = t.data.indexOf("每加载"), j = t.data.indexOf("工作量") + 3;
    const rg = document.createRange(); rg.setStart(t, i); rg.setEnd(t, j);
    const s = getSelection()!; s.removeAllRanges(); s.addRange(rg);
    return [...rg.getClientRects()].filter((q) => q.width > 0).map((q) => ({ l: q.left, r: q.right, t: q.top }));
  });
  const bubble = pg.locator(".md-bubble");
  await bubble.waitFor();
  await until(h, "the toolbar is placed", async () => ((await bubble.boundingBox())?.y ?? 0) > 0);
  const bb = (await bubble.boundingBox())!, cx = bb.x + bb.width / 2, first = lines[0];
  await shot(h, "static-toolbar-first-line");
  check("staticToolbarOverFirstLine", lines.length >= 2 && cx >= first.l - 4 && cx <= first.r + 4 && bb.y + bb.height <= first.t, { lines, bubble: bb });
  await h.page.context().close();
});
