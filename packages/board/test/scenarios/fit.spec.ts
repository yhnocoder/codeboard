//  fitIncludesLinkLabelsAndAltBar — Fit to Window frames what is drawn beside the cards too: a long label on a line that bulges
//                                    out to the right and the grey alternatives column beside the call's target stay on screen
import { emptyBoard, type CodeCard, type NoteCard } from "@codeboard/core";
import { put, symCard, findSym, shot, type Host } from "../harness";
import { test, open, check, idle, until, focusSettled } from "../fixtures";

const nv = (qual: string) => {
  const s = findSym(qual);
  return symCard(s.f, s.s);
};
const lineOf = (c: CodeCard, re: RegExp) => {
  const s = c.segments[0];
  return s.start + s.text.findIndex((t) => re.test(t));
};
const close = (h: Host) => h.page.context().close();

test("fitIncludesLinkLabelsAndAltBar", async () => {
  // Two cards one above the other in a narrow panel (the VS Code side panel of the report): the line leaves and enters on the
  // right, so it bulges out past both cards, and the alternatives column sits right of the lower card
  const b = emptyBoard("bFit", "fit");
  const step = nv("LLMEngine.step"),
    sch = nv("Scheduler.schedule");
  put(b, step, 80, 80, 560);
  put(b, sch, 80, 700, 560);
  b.links.push({
    id: "l-sch",
    from: { card: step.id, seg: step.segments[0].id, line: lineOf(step, /scheduler\.schedule\(/) },
    to: { card: sch.id },
    sides: { from: "right", to: "right" },
    label: "picks the sequences to run in this step, prefill first",
    call: {
      name: "schedule",
      col: 0,
      impls: 3,
      alts: [
        { label: "PriorityScheduler.schedule", detail: "engine/priority.py:41", qual: "PriorityScheduler.schedule" },
        { label: "ChunkedScheduler.schedule", detail: "engine/chunked.py:18", qual: "ChunkedScheduler.schedule" },
      ],
    },
  });
  const h = await open({ board: b, w: 700, h: 900 });
  await h.page.locator(".altcol").waitFor();
  await h.page.locator(".vchips .vlabel").waitFor();
  await h.page.mouse.click(40, 600);
  await idle(h); // empty canvas: focus in the board, nothing selected
  await h.page.keyboard.press("Shift+Digit1");
  await idle(h);
  await shot(h, "fit-labels-altbar");
  const got = await h.page.evaluate(() => {
    const box = (e: Element) => {
      const r = e.getBoundingClientRect();
      return { l: Math.round(r.left), t: Math.round(r.top), r: Math.round(r.right), b: Math.round(r.bottom) };
    };
    return {
      w: innerWidth,
      h: innerHeight,
      labels: [...document.querySelectorAll(".vchips")].map(box),
      alts: [...document.querySelectorAll(".altcol")].map(box),
      cards: [...document.querySelectorAll(".card[data-id]")].map(box),
    };
  });
  const inside = (r: { l: number; t: number; r: number; b: number }) =>
    r.l >= 0 && r.t >= 0 && r.r <= got.w && r.b <= got.h;
  check("fitIncludesLinkLabelsAndAltBar label on screen", got.labels.length === 1 && got.labels.every(inside), got);
  check(
    "fitIncludesLinkLabelsAndAltBar alternatives column on screen",
    got.alts.length === 1 && got.alts.every(inside),
    got,
  );
  check("fitIncludesLinkLabelsAndAltBar cards on screen", got.cards.length === 2 && got.cards.every(inside), got);
  await close(h);
});

const FREE = "def f():\n    return some_function_with_a_long_name(argument_one, argument_two, argument_three)\n";
const free = (id: string): CodeCard =>
  ({
    id,
    kind: "code",
    segments: [
      {
        id: `s${id}`,
        src: { kind: "free" },
        path: "",
        lang: "python",
        start: 1,
        end: 2,
        text: FREE.split("\n").slice(0, 2),
        version: { kind: "none" },
      },
    ],
  }) as unknown as CodeCard;
/** ⌥F as a Mac keyboard sends it: the key for F with Option, whose text is "ƒ" (typed unless something takes the key) */
async function macAltF(h: Host) {
  const cdp = await h.page.context().newCDPSession(h.page);
  const k = { key: "ƒ", code: "KeyF", windowsVirtualKeyCode: 70, nativeVirtualKeyCode: 70, modifiers: 1 };
  await cdp.send("Input.dispatchKeyEvent", { type: "keyDown", text: "ƒ", unmodifiedText: "f", ...k });
  await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", ...k });
  await cdp.detach();
}
const caret = (h: Host) =>
  h.page.evaluate(() => {
    const pm = (document.querySelector(".md-pm") as any)?.editor;
    if (pm) return { from: pm.state.selection.from, to: pm.state.selection.to };
    const s = getSelection()!;
    return { node: s.anchorNode?.textContent?.slice(0, 40), at: s.anchorOffset };
  });
const focusIn = (h: Host, id: string) =>
  h.page.evaluate((id) => !!document.activeElement?.closest(`.card[data-id="${id}"]`), id);

/** ⌥F while editing: fits the Note being edited and the Free code card being edited, with no "ƒ" typed, the editor
 *  still open with the caret where it was (typing goes on there); one undo step like ⌥F on a selected card */
test("fitContentKeyWhileEditing", async () => {
  const b = emptyBoard("bFitEd", "fit while editing");
  put(b, { id: "n1", kind: "note", look: "note", md: "第一行\n\n第二行" } as NoteCard, 40, 40, 380);
  b.place.n1.h = 420;
  put(b, free("f1"), 480, 40, 260);
  b.cam = { x: 0, y: 0, z: 1 };
  const h = await open({ board: b, light: true, w: 1200, h: 700, settings: { theme: "warm-ink" } as never });
  const pg = h.page;
  await idle(h);
  await pg.locator('.card[data-id="n1"] .nbody p').first().dblclick();
  await pg.waitForSelector('.card[data-id="n1"] .md-pm', { timeout: 5000 });
  await focusSettled(pg);
  await pg.keyboard.press("ControlOrMeta+End");
  const c0 = await caret(h);
  await macAltF(h);
  await until(h, "⌥F fits the Note", () => h.board().place.n1.h === undefined).catch(() => undefined);
  await idle(h);
  const c1 = await caret(h),
    open1 = (await pg.locator('.card[data-id="n1"] .md-pm').count()) === 1,
    focus1 = await focusIn(h, "n1");
  await pg.keyboard.type("Z");
  await pg.keyboard.press("Escape");
  await until(
    h,
    "Esc saves the Note",
    () => (h.board().cards.find((c) => c.id === "n1") as NoteCard).md !== "第一行\n\n第二行",
  ).catch(() => undefined);
  const md = (h.board().cards.find((c) => c.id === "n1") as NoteCard).md;
  check(
    "fitContentKeyWhileEditing Note fitted, still editing, caret kept, no ƒ",
    h.board().place.n1.h === undefined &&
      open1 &&
      focus1 &&
      JSON.stringify(c0) === JSON.stringify(c1) &&
      md === "第一行\n\n第二行Z",
    { h: h.board().place.n1.h, open1, focus1, c0, c1, md },
  );
  // undo: the typed Z (the Note's edit), then the fit
  await pg.keyboard.press("ControlOrMeta+z");
  await idle(h);
  if (h.board().place.n1.h === undefined) await pg.keyboard.press("ControlOrMeta+z");
  await until(h, "⌘Z undoes the fit", () => h.board().place.n1.h === 420).catch(() => undefined);
  check("fitContentKeyWhileEditing Note fit undoes", h.board().place.n1.h === 420, h.board().place.n1);
  // the Free code card
  await pg.locator('.card[data-id="f1"] .src .l').nth(0).dblclick();
  await pg.waitForSelector('.card[data-id="f1"] .cm-content', { timeout: 8000 });
  await focusSettled(pg);
  const w0 = h.board().place.f1.w,
    k0 = await caret(h);
  await macAltF(h);
  await until(h, "⌥F fits the Free code card", () => h.board().place.f1.w !== w0).catch(() => undefined);
  await idle(h);
  const k1 = await caret(h),
    open2 = (await pg.locator('.card[data-id="f1"] .cm-content').count()) === 1,
    focus2 = await focusIn(h, "f1");
  const text = await pg.locator('.card[data-id="f1"] .cm-content').innerText();
  check(
    "fitContentKeyWhileEditing Free code card fitted, still editing, caret kept, no ƒ",
    h.board().place.f1.w > w0 && open2 && focus2 && JSON.stringify(k0) === JSON.stringify(k1) && !text.includes("ƒ"),
    { w0, w: h.board().place.f1.w, open2, focus2, k0, k1, text },
  );
  await shot(h, "fit-key-while-editing");
  // the same width as ⌥F on the card when it is not being edited
  const wEdit = h.board().place.f1.w;
  await pg.keyboard.press("Escape");
  await pg.waitForSelector('.card[data-id="f1"] .cm-content', { state: "detached", timeout: 5000 });
  await pg.keyboard.press("ControlOrMeta+z");
  await until(h, "⌘Z undoes the fit", () => h.board().place.f1.w === w0).catch(() => undefined);
  await pg.locator('.card[data-id="f1"] .chead').click();
  await pg.mouse.move(1180, 680);
  await idle(h);
  await pg.keyboard.press("Alt+KeyF");
  await until(h, "⌥F fits the selected card", () => h.board().place.f1.w !== w0).catch(() => undefined);
  check(
    "fitContentKeyWhileEditing Free code card as wide as when fitted outside the editor",
    Math.abs(h.board().place.f1.w - wEdit) <= 2,
    { wEdit, shown: h.board().place.f1.w },
  );
});

/** ⌥F fits the card under the pointer without selecting it, before the selected card; with the pointer off the cards, the selection */
test("fitContentKeyHoveredCard", async () => {
  const b = emptyBoard("bFitHov", "fit hovered");
  put(b, { id: "a", kind: "note", look: "note", md: "选中的" } as NoteCard, 40, 40, 300);
  put(b, { id: "b", kind: "note", look: "note", md: "指针下的" } as NoteCard, 400, 40, 300);
  b.place.a.h = 300;
  b.place.b.h = 300;
  b.cam = { x: 0, y: 0, z: 1 };
  const h = await open({ board: b, light: true, w: 900, h: 600, settings: { theme: "warm-ink" } as never });
  const pg = h.page;
  await idle(h);
  await pg.locator('.card[data-id="a"] .chead').click();
  await pg.locator('.card[data-id="a"].sel').waitFor();
  const r = (await pg.locator('.card[data-id="b"]').boundingBox())!;
  await pg.mouse.move(r.x + r.width / 2, r.y + r.height / 2);
  await idle(h);
  await pg.keyboard.press("Alt+KeyF");
  await until(h, "⌥F fits the hovered card", () => h.board().place.b.h === undefined).catch(() => undefined);
  await idle(h);
  const hovered = {
    a: h.board().place.a.h,
    b: h.board().place.b.h,
    bSelected: await pg.locator('.card[data-id="b"].sel').count(),
    aSelected: await pg.locator('.card[data-id="a"].sel').count(),
  };
  check(
    "fitContentKeyHoveredCard fits the card under the pointer, not the selected one, and does not select it",
    hovered.a === 300 && hovered.b === undefined && hovered.bSelected === 0 && hovered.aSelected === 1,
    hovered,
  );
  await pg.mouse.move(860, 560);
  await idle(h);
  await pg.keyboard.press("Alt+KeyF");
  await until(h, "⌥F fits the selected card", () => h.board().place.a.h === undefined).catch(() => undefined);
  check(
    "fitContentKeyHoveredCard off the cards it fits the selection",
    h.board().place.a.h === undefined,
    h.board().place,
  );
});
