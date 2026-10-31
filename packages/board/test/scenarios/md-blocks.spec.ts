import * as path from "node:path";
import { OUT, put, type Host } from "../harness";
import { emptyBoard, type NoteCard } from "@codeboard/core";
import { test, open, check, light, until, idle } from "../fixtures";

const card = (id: string) => `.card[data-id="${id}"]`;
const md = (h: Host, id: string) => (h.board().cards.find((c) => c.id === id) as NoteCard).md;
function board(notes: { id: string; md: string; w: number; x?: number; y?: number }[]) {
  const b = emptyBoard("b1", "markdown blocks");
  notes.forEach((n, i) =>
    put(b, { id: n.id, kind: "note", md: n.md, look: "note" } as NoteCard, n.x ?? 60 + i * 470, n.y ?? 80, n.w),
  );
  b.cam = { x: 0, y: 0, z: 1 };
  return b;
}
async function shot(h: Host, id: string, name: string, keepMouse = false) {
  if (!keepMouse) await h.page.mouse.move(2, 2);
  await idle(h);
  const r = await h.page.locator(card(id)).boundingBox();
  if (!r) return;
  const m = 30;
  await h.page.screenshot({
    path: path.join(OUT, `md-blocks-${name}.png`),
    clip: { x: Math.max(0, r.x - m), y: Math.max(0, r.y - m), width: r.width + 2 * m, height: r.height + 2 * m + 60 },
  });
}
async function edit(h: Host, id: string, pos?: { x: number; y: number }) {
  await h.page.locator(`${card(id)} .nbody`).dblclick(pos ? { position: pos } : undefined);
  await h.page.waitForSelector(`${card(id)} .md-pm`, { timeout: 5000 });
}
async function leave(h: Host, id: string, before: string) {
  await h.page.keyboard.press("Escape");
  await until(h, "Esc saves the Note", () => md(h, id) !== before);
  await idle(h);
  await h.page.waitForSelector(`${card(id)} .md-pm`, { state: "detached", timeout: 5000 });
}
/** The text of each list item in a card's static body or editor, in order */
const liTexts = (h: Host, sel: string) =>
  h.page.locator(`${sel} li`).evaluateAll((ls) => ls.map((l) => (l.textContent ?? "").trim()));

/** An ordered list "1. a" plus an empty "2." left by Enter is still a list of two items after leaving the editor (not an indented
 *  "2." of text), and editing again resumes the empty item; an empty task item is kept too */
test("noteEmptyListItem", async () => {
  const h = await open({
    board: board([
      { id: "n1", md: "1. a", w: 400 },
      { id: "n2", md: "- [ ] a", w: 400 },
    ]),
    light,
    w: 1000,
    h: 500,
  });
  const pg = h.page;
  await idle(h);
  for (const id of ["n1", "n2"]) {
    const src = md(h, id);
    await edit(h, id);
    await pg.keyboard.press("ControlOrMeta+End");
    await pg.keyboard.press("Enter");
    await shot(h, id, `01-${id}-editing`, true);
    await leave(h, id, src);
  }
  await shot(h, "n1", "01-ordered-saved");
  await shot(h, "n2", "01-task-saved");
  const saved = { n1: md(h, "n1"), n2: md(h, "n2") };
  const shown = { n1: await liTexts(h, `${card("n1")} .nbody`), n2: await liTexts(h, `${card("n2")} .nbody`) };
  const boxes = await pg.locator(`${card("n2")} .nbody input[type=checkbox]`).count();
  check("noteEmptyListItem saved", saved.n1 === "1. a\n2." && saved.n2 === "- [ ] a\n- [ ]", saved);
  check(
    "noteEmptyListItem shown as list items",
    JSON.stringify(shown.n1) === '["a",""]' && JSON.stringify(shown.n2) === '["a",""]' && boxes === 2,
    { shown, boxes },
  );
  // 再次编辑：还是两项，光标进空的那一项打字，存成 "2. b"
  await edit(h, "n1");
  const again = await liTexts(h, `${card("n1")} .md-pm`);
  await pg.keyboard.press("ControlOrMeta+End");
  await pg.keyboard.type("b");
  await shot(h, "n1", "01-ordered-edit-again", true);
  await leave(h, "n1", saved.n1);
  check(
    "noteEmptyListItem edits again as an empty item",
    JSON.stringify(again) === '["a",""]' && md(h, "n1") === "1. a\n2. b",
    { again, md: md(h, "n1") },
  );
});

/** A $$…$$ in the middle of a line is a display formula centred on a line of its own, the same size in the static Note and the
 *  editor; a $$ block on its own lines is a display block too */
test("inlineDisplayMath", async () => {
  const src = "1. 3\n2. 3 $$2 * (\\text{threadIdx.x} + \\sum_{i=1}^n x_i)$$ end\n3. 4\n\n$$\nx^2\n$$";
  const h = await open({ board: board([{ id: "n1", md: src, w: 520 }]), light, w: 800, h: 500 });
  const pg = h.page;
  await idle(h);
  const measure = (root: string) =>
    pg.evaluate((root) => {
      const li = document.querySelectorAll(`${root} li`)[1] as HTMLElement;
      const k = li?.querySelector(".katex") as HTMLElement | null;
      const r = k?.getBoundingClientRect(),
        lr = li?.getBoundingClientRect();
      return {
        inLiDisplay: li?.querySelectorAll(".katex-display").length ?? -1,
        h: r ? Math.round(r.height) : 0,
        w: r ? Math.round(r.width) : 0,
        // centred on a line of its own, not right after "3 "
        centred: (() => {
          const d = k?.closest(".md-dmath"),
            dr = d?.getBoundingClientRect();
          return (
            !!r &&
            !!dr &&
            getComputedStyle(d!).display === "block" &&
            Math.abs(r.left + r.width / 2 - (dr.left + dr.width / 2)) <= 3
          );
        })(),
        opLimits: !!k?.querySelector(".op-limits"),
        blocks: document.querySelectorAll(`${root} .katex-display`).length,
      };
    }, root);
  const view = await measure(`${card("n1")} .nbody`);
  await shot(h, "n1", "02-display");
  await edit(h, "n1", { x: 300, y: 4 });
  const ed = await measure(`${card("n1")} .md-pm`);
  await shot(h, "n1", "02-editing", true);
  // $$…$$ inside a line is a display formula: centred on its own line, \sum's limits above and below it (op-limits)
  check(
    "inlineDisplayMath display formula on its own line",
    view.inLiDisplay === 1 && view.centred && view.opLimits && view.blocks === 2,
    view,
  );
  check(
    "inlineDisplayMath same in editor",
    ed.inLiDisplay === 1 && ed.centred && ed.opLimits && Math.abs(ed.h - view.h) <= 1 && Math.abs(ed.w - view.w) <= 2,
    { view, ed },
  );
  await pg.keyboard.press("Escape");
  await idle(h);
  check("inlineDisplayMath source unchanged", md(h, "n1") === src, md(h, "n1"));
});

const WIDE =
  "如果只有一维，那么计算全局索引的方式如下：\n\n$$\ni=\\text{blockIdx.x} \\times \\text{blockDim.x} + \\text{threadIdx.x} + \\text{gridDim.x} \\times \\text{blockDim.x}\n$$\n\nafter the formula";
/** A display formula wider than the Note scrolls sideways inside its own box: it does not stick out, is not cut off vertically,
 *  nothing overlaps it, and the Note grows to fit; with the formula's LaTeX open in the editor, the source wraps and the Note
 *  grows with it (the source is not clipped and the preview stays below it) */
test("wideDisplayMath", async () => {
  const h = await open({ board: board([{ id: "n1", md: WIDE, w: 300 }]), light, w: 800, h: 700 });
  const pg = h.page;
  await idle(h);
  const layout = (root: string, box: string) =>
    pg.evaluate(
      ({ root, box }) => {
        const r = (e: Element | null) => e?.getBoundingClientRect();
        const body = document.querySelector(`${root}`) as HTMLElement,
          m = body.querySelector(box) as HTMLElement;
        const kd = m.querySelector(".katex-display, .katex") as HTMLElement,
          next = [...body.querySelectorAll("p")].pop()!;
        const mr = r(m)!,
          br = r(body)!,
          nr = r(next)!,
          kr = r(kd)!,
          cr = r(body.closest(".card"))!;
        const cs = getComputedStyle(m);
        return {
          scrolls: m.scrollWidth > m.clientWidth + 1 && /auto|scroll/.test(cs.overflowX),
          inside: mr.left >= br.left - 1 && mr.right <= br.right + 1,
          // 公式整个高度都在它的框里（没有被上下裁掉），下面那一段在它下面
          notClipped: kr.top >= mr.top - 1 && kr.bottom <= mr.bottom + 1,
          below: nr.top >= mr.bottom - 0.5,
          fits: body.scrollHeight <= body.clientHeight + 1 && nr.bottom <= cr.bottom + 0.5,
        };
      },
      { root, box },
    );
  const view = await layout(`${card("n1")} .nbody`, ".math");
  await shot(h, "n1", "03-display");
  check("wideDisplayMath display", Object.values(view).every(Boolean), view);
  await edit(h, "n1", { x: 20, y: 6 });
  await pg.locator(`${card("n1")} .md-pm [data-type="block-math"]`).click();
  await pg.waitForSelector(`${card("n1")} .md-pm [data-type="block-math"].is-open textarea`, { timeout: 3000 });
  await idle(h);
  const ed = await pg.evaluate(
    (q) => {
      const t = document.querySelector(`${q} textarea.md-mathsrc`) as HTMLTextAreaElement,
        pv = document.querySelector(`${q} .block-math-inner`)!;
      const body = document.querySelector(q.replace(" .md-pm", " .nbody")) as HTMLElement,
        cr = body.closest(".card")!.getBoundingClientRect();
      const last = [...document.querySelectorAll(`${q} p`)].filter((p) => p.textContent).pop()!;
      return {
        srcWhole: t.scrollHeight <= t.clientHeight + 1,
        previewBelow: pv.getBoundingClientRect().top >= t.getBoundingClientRect().bottom - 0.5,
        fits: body.scrollHeight <= body.clientHeight + 1 && last.getBoundingClientRect().bottom <= cr.bottom + 0.5,
      };
    },
    `${card("n1")} .md-pm`,
  );
  await shot(h, "n1", "03-editing-source", true);
  check("wideDisplayMath source open", Object.values(ed).every(Boolean), ed);
  await pg.keyboard.press("Escape");
  await pg.keyboard.press("Escape");
  await idle(h);
});

const TWO_CODE =
  "同样是 n 个数，可以用\n\n```cuda\nvecAddKernel<<<ceil(n/128), 128>>>(...);\n```\n\n```cuda\nvecAddKernel<<<dim3(128, 1, 1), dim3(256, 1, 1)>>>(...);\n```";
/** Between two adjacent code blocks the cursor can stop (a gap cursor): by ↓ out of the first block's last line, by a click in the
 *  gap between them or on the padding next to it; typing or Enter there makes a new paragraph between the blocks. ↑ out of a code
 *  block that is the first block stops before it */
test("codeBlockGapCursor", async () => {
  const src =
    "```cuda\nvecAddKernel<<<ceil(n/128), 128>>>(...);\n```\n\n```cuda\nvecAddKernel<<<dim3(128, 1, 1), dim3(256, 1, 1)>>>(...);\n```";
  const h = await open({ board: board([{ id: "n1", md: src, w: 520 }]), light, w: 900, h: 600 });
  const pg = h.page;
  await idle(h);
  await edit(h, "n1");
  const pm = `${card("n1")} .md-pm`,
    pres = `${pm} pre.md-code`;
  const gaps = () => pg.locator(`${pm} .ProseMirror-gapcursor`).count();
  const order = () =>
    pg
      .locator(`${pm} > :not(.md-pad)`)
      .evaluateAll((es) =>
        es.map((e) => e.tagName.toLowerCase() + (e.tagName === "P" ? `:${e.textContent}` : "")).join(","),
      );
  await pg.locator(`${pres} .cm-content`).first().click();
  await pg.keyboard.press("End");
  await pg.keyboard.press("ArrowDown");
  const byKey = await gaps();
  await pg.keyboard.type("between");
  await until(h, "the typed paragraph shows", () => pg.locator(`${pm} p`, { hasText: "between" }).count());
  const typed = await order();
  // 点在两块之间：先撤掉刚打的那段，两块又挨在一起
  await pg.keyboard.press("ControlOrMeta+z");
  await until(
    h,
    "undo removes the paragraph",
    async () => !(await pg.locator(`${pm} p`, { hasText: "between" }).count()),
  );
  const box = () =>
    pg
      .locator(pres)
      .evaluateAll((es) =>
        es
          .map((e) => e.getBoundingClientRect())
          .map((r) => ({ x: r.left + r.width / 2, top: r.top, bottom: r.bottom })),
      );
  let [a, b] = await box();
  await pg.mouse.click(a.x, (a.bottom + b.top) / 2);
  const byClick = await gaps();
  await shot(h, "n1", "08-gap-cursor", true);
  await pg.locator(`${pres} .cm-content`).last().click();
  [a, b] = await box();
  await pg.mouse.click(a.x, a.bottom - 2);
  const byPadding = await gaps();
  await pg.keyboard.press("Enter");
  await pg.keyboard.type("clicked");
  // 第一块：↑ 走出去停在它前面
  await pg.locator(`${pres} .cm-content`).first().click();
  await pg.keyboard.press("Home");
  await pg.keyboard.press("ArrowUp");
  const beforeFirst = await gaps();
  await pg.keyboard.type("top");
  await until(h, "the paragraph before the first block shows", () => pg.locator(`${pm} p`, { hasText: "top" }).count());
  const final = await order();
  const before = md(h, "n1");
  await pg.keyboard.press("Escape");
  await until(h, "Esc saves the Note", () => md(h, "n1") !== before);
  await idle(h);
  const saved = md(h, "n1");
  check("codeBlockGapCursor by key", byKey === 1 && typed === "pre,p:between,pre", { byKey, typed });
  check("codeBlockGapCursor by click", byClick === 1 && byPadding === 1, { byClick, byPadding });
  check("codeBlockGapCursor before the first block", beforeFirst === 1 && final === "p:top,pre,p:clicked,pre", {
    beforeFirst,
    final,
  });
  check("codeBlockGapCursor saved", saved === `top\n\n${src.replace("```\n\n```", "```\n\nclicked\n\n```")}`, {
    saved,
  });
});

/** The code block's pill (language, copy, wrap, menu) floats over the block's top-right corner, opaque, and only while it is
 *  wanted: hovering the block or the caret in it. Otherwise it is invisible and lets clicks through to the code under it */
test("codeBlockLabelClear", async () => {
  const h = await open({ board: board([{ id: "n1", md: TWO_CODE, w: 400 }]), light, w: 900, h: 600 });
  const pg = h.page;
  await idle(h);
  await edit(h, "n1", { x: 20, y: 6 });
  const pres = `${card("n1")} .md-pm pre.md-code`;
  /** per block: pill shown (opacity), takes clicks, its background is opaque, and it lies inside the block's top-right corner */
  const pills = () =>
    pg.locator(pres).evaluateAll((ps) =>
      ps.map((p) => {
        const pill = p.querySelector(".md-cbpill") as HTMLElement,
          cs = getComputedStyle(pill),
          r = pill.getBoundingClientRect(),
          b = p.getBoundingClientRect();
        return {
          shown: Number(cs.opacity) > 0.95,
          clicks: cs.pointerEvents !== "none",
          opaque: !/rgba\(.*, 0(\.\d+)?\)$|transparent/.test(cs.backgroundColor),
          corner: r.right <= b.right && r.top >= b.top && r.right > b.right - 20,
        };
      }),
    );
  // the caret in the first paragraph, the mouse away: no pill
  await pg.mouse.move(5, 5);
  await idle(h);
  const away = await pills();
  // at the start of the code: the pill sits over the top-right corner of the block's first line
  await pg
    .locator(`${pres} .cm-content`)
    .last()
    .click({ position: { x: 2, y: 4 } });
  await pg.keyboard.press("End");
  await pg.mouse.move(5, 5);
  await idle(h);
  const focused = await pills();
  await pg.locator(pres).first().hover();
  await idle(h);
  const hovered = await pills();
  await shot(h, "n1", "08-label-hover", true);
  const ok =
    away.every((x) => !x.shown && !x.clicks) &&
    focused[1].shown &&
    focused[1].clicks &&
    !focused[0].shown &&
    hovered[0].shown &&
    [...focused, ...hovered].every((x) => !x.shown || (x.opaque && x.corner));
  check("codeBlockLabelClear", ok, { away, focused, hovered });
  await pg.keyboard.press("Escape");
  await idle(h);
});

/** A code block whose long line runs past the Note: at rest it does not scroll (a block that can scroll is a composited layer
 *  of its own, and a board of such Notes is slow to zoom and pan); on the card pointed at, selected or edited it scrolls
 *  sideways, with no change in its size or where its text sits */
test("noteCodeBlockScrollsOnlyWhenActive", async () => {
  const long = `x = compute(${Array.from({ length: 30 }, (_, i) => `arg_${i}`).join(", ")})`;
  const h = await open({
    board: board([
      { id: "a", md: `Code:\n\n\`\`\`python\n${long}\nprint(x)\n\`\`\`\n\nAfter.`, w: 420 },
      { id: "b", md: "Other note", w: 300 },
    ]),
    light,
  });
  const pg = h.page,
    pre = pg.locator(`${card("a")} .nbody pre.md-code`).first();
  await pg.mouse.move(2, 2);
  await idle(h);
  const look = () =>
    pre.evaluate((el) => {
      const r = el.getBoundingClientRect(),
        t = el.querySelector("code")!.getBoundingClientRect();
      return {
        ox: getComputedStyle(el).overflowX,
        oy: getComputedStyle(el).overflowY,
        h: r.height,
        w: r.width,
        textY: t.y,
        over: el.scrollWidth > el.clientWidth + 20,
      };
    });
  const rest = await look();
  const r = (await pre.boundingBox())!;
  await pg.mouse.move(r.x + r.width / 2, r.y + r.height / 2);
  await idle(h);
  const hover = await look();
  await pg.locator(`${card("b")} .nbody`).click();
  await pg.locator(`${card("a")} .chead`).click();
  await pg.mouse.move(2, 2);
  await idle(h);
  const selected = await look();
  check(
    "noteCodeBlockScrollsOnlyWhenActive not a scroller at rest",
    rest.over && rest.ox !== "auto" && rest.ox !== "scroll" && rest.oy !== "auto" && rest.oy !== "scroll",
    rest,
  );
  check(
    "noteCodeBlockScrollsOnlyWhenActive scrolls when pointed at or selected",
    hover.ox === "auto" && selected.ox === "auto",
    { hover, selected },
  );
  check(
    "noteCodeBlockScrollsOnlyWhenActive nothing moves",
    hover.h === rest.h && hover.w === rest.w && hover.textY === rest.textY && selected.h === rest.h,
    { rest, hover, selected },
  );
  await h.page.context().close();
});
