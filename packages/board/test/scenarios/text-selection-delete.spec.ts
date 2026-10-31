import * as fs from "node:fs";
import * as path from "node:path";
import { emptyBoard, type Board, type CodeCard, type NoteCard } from "@codeboard/core";
import type { Page } from "playwright-core";
import { put, findSym, symCard, shot, OUT, type Host } from "../harness";
import { test, open, check, light, until, idle, pmHasSelection } from "../fixtures";

const close = (h: Host) => h.page.context().close();
const NOTE = "## Plan\n\nalpha brave charlie\n\nsecond **line** here";
const CODE = ["def f(x):", "    y = x + 1", "    return y"];

function board(): Board {
  const b = emptyBoard("b1", "text selection delete");
  put(b, { id: "n0", kind: "note", md: NOTE, look: "note" } as NoteCard, 80, 80, 360);
  b.cards.push({
    id: "c1",
    kind: "code",
    segments: [
      {
        id: "s1",
        src: { kind: "free" },
        path: "",
        lang: "python",
        start: 1,
        end: CODE.length,
        text: CODE.slice(),
        version: { kind: "none" },
      },
    ],
  } as unknown as CodeCard);
  b.place.c1 = { x: 520, y: 80, w: 420 };
  const s = findSym("Scheduler.schedule");
  put(b, symCard(s.f, s.s), 80, 460, 520);
  b.cam = { x: 0, y: 0, z: 1 };
  return b;
}
const cards = (h: Host) => h.board().cards.map((c) => c.id);
const noteMd = (h: Host) => ((h.board().cards.find((c) => c.id === "n0") as NoteCard | undefined)?.md ?? "").trim();
const freeText = (h: Host) =>
  ((h.board().cards.find((c) => c.id === "c1") as CodeCard | undefined)?.segments[0].text ?? []).join("\n");
/** The editor's text as shown: the source's markers away from the caret are hidden (.md-hide) */
const pmText = (pg: Page) =>
  pg.evaluate(() => {
    const e = document.querySelector('.card[data-id="n0"] .md-pm');
    if (!e) return null;
    const c = e.cloneNode(true) as HTMLElement;
    c.querySelectorAll(".md-hide").forEach((x) => x.remove());
    return c.textContent;
  });
const cmText = (pg: Page) =>
  pg.evaluate(() =>
    [...document.querySelectorAll('.card[data-id="c1"] .cm-line')].map((l) => l.textContent).join("\n"),
  );

/** 用鼠标拖选 root 里的 word（第一个出现的地方）：先点卡头只选中这张卡（没选中的卡按在内容上是拖卡），再从它第一个字的左边拖到最后一个字的右边 */
async function dragSelect(pg: Page, root: string, word: string) {
  const card = root.split(" ")[0];
  await pg
    .locator(`${card} .chead`)
    .first()
    .click({ position: { x: 30, y: 10 } });
  await pg.locator(`${card}.sel.solo`).waitFor();
  const r = await pg.evaluate(
    ([root, word]) => {
      // 字可能分在几个文字节点里（代码着色）：连起来找
      const w = document.createTreeWalker(document.querySelector(root)!, NodeFilter.SHOW_TEXT);
      const ts: Text[] = [];
      for (let t = w.nextNode(); t; t = w.nextNode()) ts.push(t as Text);
      const i = ts
        .map((t) => t.data)
        .join("")
        .indexOf(word);
      if (i < 0) return null;
      const rg = document.createRange();
      const at = (k: number) => {
        for (const t of ts) {
          if (k < t.data.length) {
            rg.setStart(t, k);
            rg.setEnd(t, k + 1);
            return rg.getBoundingClientRect();
          }
          k -= t.data.length;
        }
        throw new Error("past the end");
      };
      const a = at(i),
        b = at(i + word.length - 1);
      return { x0: a.left + 1, x1: b.right - 1, y: (a.top + a.bottom) / 2 };
    },
    [root, word] as const,
  );
  if (!r) throw new Error(`dragSelect: "${word}" is not in ${root}`);
  await pg.mouse.move(r.x0, r.y);
  await pg.mouse.down();
  await pg.mouse.move(r.x1, r.y, { steps: 6 });
  await pg.mouse.up();
  await pg.waitForFunction((w) => window.getSelection()?.toString() === w, word, { timeout: 5000 });
}
async function save(name: string) {
  const d = process.env.SHOTS_DIR;
  if (!d) return;
  fs.mkdirSync(d, { recursive: true });
  fs.copyFileSync(path.join(OUT, `${name}.png`), path.join(d, `${name}.png`));
}

/** 显示着的 Note 里拖选一个词再按 ⌫：卡还在、进入编辑、这个词删掉了（编辑器里 ⌘Z 一步撤回、⇧⌘Z 再删），退出后存下来；白板上撤销一步回到原文 */
test("deleteKeyWithTextSelectionEditsNote", async () => {
  const h = await open({ board: board(), light, w: 1100, h: 800, settings: { theme: "warm-ink" } as never });
  await idle(h);
  const pg = h.page;
  await dragSelect(pg, '.card[data-id="n0"] .nbody', "brave");
  await shot(h, "deleteKeyText-1-selected", "now");
  await save("deleteKeyText-1-selected");
  await pg.keyboard.press("Backspace");
  await pg.waitForSelector('.card[data-id="n0"] .md-pm', { timeout: 5000 });
  await until(h, "the word is deleted in the editor", async () => !(await pmText(pg))?.includes("brave"));
  await idle(h);
  await shot(h, "deleteKeyText-2-edited", "now");
  await save("deleteKeyText-2-edited");
  const edited = await pmText(pg);
  check("deleteKeyWithTextSelectionEditsNote card kept, editing", cards(h).includes("n0") && edited !== null, {
    cards: cards(h),
    edited,
  });
  check(
    "deleteKeyWithTextSelectionEditsNote only the word is deleted",
    !!edited?.includes("alpha  charlie") && edited.includes("second line here") && edited.includes("Plan"),
    { edited },
  );
  await pmHasSelection(pg);
  await pg.keyboard.press("Control+z");
  const undone = await until(h, "undo in the editor brings the word back", async () => {
    const t = await pmText(pg);
    return t?.includes("alpha brave charlie") && t;
  }).catch(() => pmText(pg));
  await pg.keyboard.press("Control+Shift+z");
  const redone = await until(h, "redo deletes it again", async () => {
    const t = await pmText(pg);
    return t?.includes("alpha  charlie") && t;
  }).catch(() => pmText(pg));
  check(
    "deleteKeyWithTextSelectionEditsNote one undo step in the editor",
    !!undone?.includes("alpha brave charlie") && !!redone?.includes("alpha  charlie"),
    { undone, redone },
  );
  await pg.keyboard.press("Escape");
  await until(h, "the edit ends", async () => (await pg.locator(".md-pm").count()) === 0);
  await idle(h);
  const saved = noteMd(h);
  check(
    "deleteKeyWithTextSelectionEditsNote saved without the word",
    saved === "## Plan\n\nalpha  charlie\n\nsecond **line** here",
    { saved },
  );
  await pg.keyboard.press("Control+z");
  await until(h, "the board's undo restores the text", () => noteMd(h) === NOTE.trim()).catch(() => {});
  check(
    "deleteKeyWithTextSelectionEditsNote one board undo step restores it",
    noteMd(h) === NOTE.trim() && cards(h).includes("n0"),
    { md: noteMd(h) },
  );
  await close(h);
});

/** 显示着的自由代码卡里拖选一段再按 Delete：进入代码编辑、删掉这段、卡还在，退出后存下来；文件里的代码选着字按 ⌫：卡也不删 */
test("deleteKeyWithTextSelectionEditsFreeCode", async () => {
  const h = await open({ board: board(), light, w: 1100, h: 800, settings: { theme: "warm-ink" } as never });
  await idle(h);
  const pg = h.page;
  await dragSelect(pg, '.card[data-id="c1"] .src', "x + 1");
  await pg.keyboard.press("Delete");
  await pg.waitForSelector('.card[data-id="c1"] .cm-content', { timeout: 5000 });
  const edited = await until(h, "the selection is deleted in the code editor", async () => {
    const t = await cmText(pg);
    return !t.includes("x + 1") && t;
  }).catch(() => cmText(pg));
  check(
    "deleteKeyWithTextSelectionEditsFreeCode card kept, editing, range deleted",
    cards(h).includes("c1") && edited === "def f(x):\n    y = \n    return y",
    { cards: cards(h), edited },
  );
  await pg.keyboard.press("Escape");
  await until(h, "the code edit ends", async () => (await pg.locator('.card[data-id="c1"] .cm-content').count()) === 0);
  await idle(h);
  check("deleteKeyWithTextSelectionEditsFreeCode saved", freeText(h) === "def f(x):\n    y = \n    return y", {
    saved: freeText(h),
  });
  // 文件里的代码（改不了）：选着字按 ⌫ 什么都不做
  const sym = h.board().cards.find((c) => c.id !== "n0" && c.id !== "c1")!.id;
  const word = await pg.evaluate(
    (id) => /\w{4,}/.exec(document.querySelector(`.card[data-id="${id}"] .src .l`)?.textContent ?? "")?.[0] ?? "",
    sym,
  );
  await dragSelect(pg, `.card[data-id="${sym}"] .src`, word);
  await pg.keyboard.press("Backspace");
  await idle(h);
  check(
    "deleteKeyWithTextSelectionEditsFreeCode file code card kept",
    cards(h).includes(sym) && cards(h).length === 3,
    { cards: cards(h), word },
  );
  await close(h);
});

/** 没选字：选中的卡照旧按 Delete / ⌫ 删掉 */
test("deleteKeyWithoutTextSelectionDeletesCard", async () => {
  const h = await open({ board: board(), light, w: 1100, h: 800 });
  await idle(h);
  const pg = h.page;
  await pg.locator('.card[data-id="n0"] .chead .ctitle').click();
  await until(h, "the Note's selection is reported", () =>
    ([...h.sent].reverse().find((m) => m.type === "selection") as { cards?: string[] } | undefined)?.cards?.includes(
      "n0",
    ),
  );
  await idle(h);
  const collapsed = await pg.evaluate(() => window.getSelection()?.isCollapsed ?? true);
  await pg.keyboard.press("Delete");
  await until(h, "the Note is deleted", () => !cards(h).includes("n0")).catch(() => {});
  check("deleteKeyWithoutTextSelectionDeletesCard", collapsed && !cards(h).includes("n0") && cards(h).includes("c1"), {
    collapsed,
    cards: cards(h),
  });
  await close(h);
});
