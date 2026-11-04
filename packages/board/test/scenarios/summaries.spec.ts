// Zoomed-out AI summaries (#130; core summary.ts, state/summary.ts, canvas/Summaries.tsx, host summaries.ts).
//   summaryLevelFade             below the board's cut the card level fades out and the summaries in, as whole layers over a
//                                timed fade; one column per top-level Section and loose card, anchored at its top-left; a Mark
//                                fades with the cards, a Free Text stays as it is, at its own size; the zoom stops at the board's minimum; crossing back mid-fade finishes the fade first
//   summaryWrittenAndEdited      on the real host with a fake DeepSeek: opening the board asks nothing, ↻ writes one item (as
//                                long as its content asks, no layout numbers); a click edits a body in place (Enter saves, marked edited, kept as a pair
//                                with the AI text it replaced), ↻ rewrites it following that edit and keeps the pair, ⌘Z brings
//                                the hand edit back; a Note with no heading shows nothing until written, then the AI's short
//                                title, titles and bodies rendered inline (refs by name, highlights) with no syntax showing
//   summaryNoKey                 without a DeepSeek key nothing is written: Section titles with empty bodies, and ↻ says a key is needed
//   summaryOverflowFades         two loose cards stacked close, each with a long summary: at rest the columns never overlap and
//                                the upper one fades out over its last lines; hovered it shows in full over the lower one, raised;
//                                a title past two lines ends in an ellipsis and shows in full the same way
//   summaryFramesOnlyBoard       a board of sub-board frames, Free Text headings and Marks, nothing to summarize: zoomed out past the
//                                cut the Marks hide all the same, and the frames and Free Text look as they do at 100 %, only scaled
import {
  emptyBoard,
  putSummary,
  summarySig,
  type Board,
  type BoardToHost,
  type NoteCard,
  type Section,
} from "@codeboard/core";
import { put, shot, type Host } from "../harness";
import { test, open, check, until, idle, hostBoards } from "../fixtures";
import { fakeDeepseek } from "../deepseek";

const note = (id: string, md: string, look: NoteCard["look"] = "note"): NoteCard => ({ id, kind: "note", md, look });

/** Three Sections of three Notes in a row (wide enough that the summary level is reachable), a loose Note, a Mark and a Free Text */
function bigBoard(id: string, z: number, written: boolean): Board {
  const b = emptyBoard(id, "summaries");
  const titles = ["异构并行计算", "内存层次", "线程调度"];
  titles.forEach((t, i) => {
    const s: Section = { id: `s${i}`, title: t, x: 80 + i * 2600, y: 80, w: 2400, h: 1400 };
    b.sections.push(s);
    for (let j = 0; j < 3; j++) {
      const n = note(
        `n${i}${j}`,
        `# ${t} ${j + 1}\n\nGPU 用大量小算术单元换**吞吐**，CPU 用大缓存换延迟。第 ${j + 1} 张。`,
      );
      put(b, n, s.x + 60 + j * 760, s.y + 100, 680);
      b.place[n.id].section = s.id;
    }
  });
  put(b, note("loose", "# 本章导读\n\n这一章从 CPU 和 GPU 的设计取舍讲起。"), 80, 1800, 900);
  put(b, note("mark", "看这里", "mark"), 2700, 1800, 300);
  put(b, note("ft", "随手写的一行", "freetext"), 4000, 1800, 600);
  if (written) {
    for (const k of ["sec:s0", "sec:s1", "sec:s2", "card:loose"])
      putSummary(b, k, {
        text: `众线程押**吞吐量**，多核押延迟（${k}）。`,
        title: k === "card:loose" ? "导读" : undefined,
        at: Date.now(),
        sig: summarySig(b, k)!,
      });
  }
  b.cam = { x: 40, y: 40, z };
  return b;
}

const zoomOf = (h: Host) =>
  h.page.evaluate(() => {
    const m = /scale\(([\d.e-]+)\)/.exec((document.querySelector(".world") as HTMLElement).style.transform);
    return m ? +m[1] : NaN;
  });
const opacity = (h: Host, sel: string) =>
  h.page.evaluate((s) => +(document.querySelector(s) as HTMLElement).style.opacity, sel);
/** Zoom by ctrl + wheel at the middle of the board (dy > 0: out) */
async function wheelZoom(h: Host, dy: number) {
  const v = h.page.viewportSize()!;
  await h.page.mouse.move(v.width / 2, v.height / 2);
  await h.page.keyboard.down("Control");
  await h.page.mouse.wheel(0, dy);
  await h.page.keyboard.up("Control");
}
/** Records every opacity the card layer gets from now on */
const recordFade = (h: Host) =>
  h.page.evaluate(() => {
    const el = document.querySelector(".cardlay") as HTMLElement,
      seen: number[] = [];
    (window as unknown as { __fade: number[] }).__fade = seen;
    new MutationObserver(() => seen.push(+el.style.opacity)).observe(el, {
      attributes: true,
      attributeFilter: ["style"],
    });
  });
const fadeSeen = (h: Host) => h.page.evaluate(() => (window as unknown as { __fade: number[] }).__fade);

test("summaryLevelFade", async () => {
  const h = await open({ board: bigBoard("bSum", 1, true), w: 1280, h: 800, light: true });
  check(
    "summaryLevelFade at 100 % the cards show and the summary level is not built yet (it is, near the cut)",
    (await opacity(h, ".cardlay")) === 1 && (await h.page.locator(".sumlay").count()) === 0,
  );
  check(
    "summaryLevelFade a Free Text is in the layer that never fades, a Mark in the card layer",
    (await h.page.locator('.keeplay .card[data-id="ft"]').count()) === 1 &&
      (await h.page.locator('.cardlay .card[data-id="mark"]').count()) === 1,
  );
  await recordFade(h);
  await wheelZoom(h, 600);
  await until(h, "the card level is gone", () => h.page.locator(".cardlay.gone").count());
  const z = await zoomOf(h);
  const seen = await fadeSeen(h);
  check(
    "summaryLevelFade the switch is a fade of the card layer, not a jump",
    seen.some((o) => o > 0.05 && o < 0.95) && seen.every((o, i) => i === 0 || o <= seen[i - 1]) && seen.at(-1) === 0,
    seen,
  );
  check("summaryLevelFade the summaries show", (await opacity(h, ".sumlay")) === 1);
  const keys = await h.page
    .locator(".sumcol")
    .evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.sum).sort());
  check(
    "summaryLevelFade one column per Section and loose card, none for the Mark or the Free Text",
    keys.join() === "card:loose,sec:s0,sec:s1,sec:s2",
    keys,
  );
  const s0 = await h.page.locator('.sumcol[data-sum="sec:s0"]').evaluate((e) => {
    const st = (e as HTMLElement).style;
    return { x: parseFloat(st.left), y: parseFloat(st.top), b: e.querySelector(".sumtx :is(b, strong)")?.textContent };
  });
  check(
    "summaryLevelFade a Section's column starts at its frame's top-left, with its key phrase bold",
    s0.x === 80 && s0.y === 80 && s0.b === "吞吐量",
    s0,
  );
  const ft = h.page.locator('.card[data-id="ft"]');
  check(
    "summaryLevelFade the Mark is hidden, the Free Text keeps its look and its own size",
    !(await h.page.locator('.card[data-id="mark"]').isVisible()) &&
      (await ft.isVisible()) &&
      (await h.page.locator(".keeplay").evaluate((e) => getComputedStyle(e).opacity)) === "1" &&
      (await ft.evaluate(
        (e) => !e.className.includes("lo-") && e.querySelector(".tx")?.textContent === "随手写的一行",
      )),
    await ft.evaluate((e) => e.className),
  );
  // the board's minimum zoom: fit-all ÷ 1.3, so zooming further out does nothing
  await wheelZoom(h, 600);
  const z2 = await zoomOf(h);
  check("summaryLevelFade the zoom stops at the board's minimum", z2 === z && z < 0.3 && z > 0.05, { z, z2 });
  // in and straight out again: the fade to the cards runs to its end, then the fade back follows
  await recordFade(h);
  await wheelZoom(h, -150);
  await wheelZoom(h, 150);
  await until(
    h,
    "back at the summaries",
    async () => (await fadeSeen(h)).at(-1) === 0 && (await fadeSeen(h)).length > 2,
  );
  const back = await fadeSeen(h);
  const top = back.indexOf(1);
  check(
    "summaryLevelFade crossing back mid-fade finishes the fade, then plays the reverse one",
    top > 0 && back.slice(top).some((o) => o > 0.05 && o < 0.95) && back.at(-1) === 0,
    back,
  );
  await h.page.context().close();
});

const sentOf = <T extends BoardToHost["type"]>(h: Host, t: T) =>
  h.sent.filter((m): m is Extract<BoardToHost, { type: T }> => m.type === t);
const summaryIn = (h: Host, id: string) => h.board().sections.find((s) => s.id === id)?.summary;

test("summaryWrittenAndEdited", async () => {
  const b = bigBoard("bW", 0.2, false);
  // a Note with no heading: its first paragraph (a [[ref]], a ==highlight==) is never its title
  put(b, note("bare", "这一段没有标题，讲 [[异构并行计算 1]] 的 ==合并访存== 和 **吞吐**。"), 5000, 1800, 600);
  const run = await hostBoards([b], {
    page: { light: true, w: 1280, h: 800, settings: { theme: "warm-ink" } },
  });
  let n = 0;
  const { calls } = await fakeDeepseek(run, (body) =>
    (body.messages[1].content as string).includes("短标题")
      ? JSON.stringify({
          title: "==访存== 与 [[异构并行计算 1]]",
          text: "**合并访存**靠 ==连续地址==，见 [[异构并行计算 1]]。",
        })
      : `第 ${++n} 版：GPU 押**吞吐量**。`,
  );
  const h = await run.open("bW");
  await idle(h);
  check("summaryWrittenAndEdited opening a board asks the AI nothing by itself", calls.length === 0, calls.length);
  const redo = async (key: string) => {
    const was = calls.length;
    await h.page.locator(`.sumcol[data-sum="${key}"] .sumhd`).hover();
    await h.page.locator(`.sumcol[data-sum="${key}"] .sumre`).click();
    await until(h, `↻ wrote ${key}`, () => calls.length > was);
  };
  await redo("sec:s1");
  await redo("card:loose");
  await until(h, "they show", async () => (await h.page.locator(".sumtx :is(b, strong)").count()) === 2);
  const asked = calls.map((c) => c.body.messages[1].content as string);
  check(
    "summaryWrittenAndEdited ↻ writes one item, its length following its content (no layout numbers asked)",
    calls.length === 2 &&
      asked.every((s) => s.includes("每个独立的关键要点写一句") && !/容量|目标约/.test(s)) &&
      asked[0].includes("Section 标题：内存层次"),
    asked.map((s) => s.length),
  );
  await until(h, "the loose card's summary is in the host's board", () => !!h.board().place.loose.summary?.text);
  const body = h.page.locator('.sumcol[data-sum="sec:s1"] .sumtx');
  await body.click();
  await until(h, "the body is editable", () => body.evaluate((e) => (e as HTMLElement).isContentEditable));
  await h.page.keyboard.press("ControlOrMeta+a");
  await h.page.keyboard.type("手改的摘要");
  await h.page.keyboard.press("Enter");
  await until(h, "the edit is saved", () => summaryIn(h, "s1")?.text === "手改的摘要");
  check("summaryWrittenAndEdited a hand edit is marked edited", summaryIn(h, "s1")?.edited === true);
  await redo("sec:s1");
  await until(h, "↻ rewrote it", () => !summaryIn(h, "s1")?.edited);
  check(
    "summaryWrittenAndEdited ↻ rewrites it following the hand edit, and keeps the edit",
    /^第 \d+ 版/.test(summaryIn(h, "s1")?.text ?? "") &&
      sentOf(h, "summarize").length === 3 &&
      summaryIn(h, "s1")?.pairs?.[0]?.user === "手改的摘要" &&
      (calls.at(-1)?.body.messages[1].content as string).includes("用户改成：\n手改的摘要"),
    summaryIn(h, "s1"),
  );
  await h.page.keyboard.press("ControlOrMeta+z");
  await until(h, "undo brings the hand edit back", () => summaryIn(h, "s1")?.text === "手改的摘要");
  await idle(h);
  check("summaryWrittenAndEdited nothing else was asked", calls.length === 3, calls.length);
  // the Note with no heading: nothing at all until written (not its first paragraph as a title), then the AI's short title;
  // titles and bodies rendered inline (the ref showing its target's name, the highlight marked), no Markdown syntax showing
  const bare = h.page.locator('.sumcol[data-sum="card:bare"]');
  const look = () =>
    bare.evaluate((e) => ({
      opacity: getComputedStyle(e).opacity,
      title: e.querySelector(".sumt")?.textContent ?? "",
      text: (e as HTMLElement).innerText,
      refs: [...e.querySelectorAll(".md-ref")].map((r) => r.textContent),
      marks: e.querySelectorAll("mark").length,
      bold: e.querySelectorAll(".sumtx :is(b, strong)").length,
    }));
  const before = await look();
  check(
    "summaryWrittenAndEdited a Note with no heading shows nothing until its summary is written, never its first paragraph",
    before.opacity === "0" && before.title === "" && !before.text.includes("这一段"),
    before,
  );
  await redo("card:bare");
  await until(h, "the untitled Note's summary shows", async () => (await look()).bold === 1);
  await h.page.mouse.move(5, 5);
  const after = await look();
  check(
    "summaryWrittenAndEdited the AI's short title and the body show rendered: the ref by its target's name, the highlight marked, no syntax",
    after.opacity === "1" &&
      after.title.includes("访存") &&
      after.refs.length === 2 &&
      after.refs.every((r) => r?.includes("异构并行计算 1")) &&
      after.marks === 2 &&
      !/\[\[|\]\]|==|\*\*/.test(after.text) &&
      (calls.at(-1)?.body.messages[1].content as string).includes("不超过 12 个字"),
    after,
  );
  await h.close();
});

test("summaryNoKey", async () => {
  const run = await hostBoards([bigBoard("bK", 0.2, false)], {
    page: { light: true, w: 1280, h: 800, settings: { theme: "warm-ink" } },
  });
  const { calls } = await fakeDeepseek(run, () => "{}", { key: null });
  const h = await run.open("bK");
  await idle(h);
  const cols = await h.page
    .locator('.sumcol[data-sum^="sec:"]')
    .evaluateAll((els) =>
      els.map((e) => [e.querySelector(".sumt")?.textContent, e.querySelector(".sumtx")?.textContent]),
    );
  check(
    "summaryNoKey without a key the summary level shows each Section's title and an empty body",
    cols.length === 3 && cols.every(([t, b]) => !!t && b === "") && calls.length === 0,
    cols,
  );
  await h.page.locator('.sumcol[data-sum="sec:s1"] .sumhd').hover();
  await h.page.locator('.sumcol[data-sum="sec:s1"] .sumre').click();
  await until(h, "a notice", () => h.page.locator(".toast").count());
  check(
    "summaryNoKey ↻ says a DeepSeek key is needed",
    (await h.page.locator(".toast").innerText()).includes("No DeepSeek API key") && calls.length === 0,
  );
  await h.close();
});

test("summaryFramesOnlyBoard", async () => {
  const kid = (id: string, name: string) => {
    const b = emptyBoard(id, name);
    for (let i = 0; i < 4; i++)
      put(b, note(`${id}n${i}`, `# ${name} ${i}`), 60 + (i % 2) * 400, 60 + Math.floor(i / 2) * 260, 340);
    return b;
  };
  const names = ["Heterogeneous computing", "Memory hierarchy", "Thread scheduling", "Parallel patterns"];
  const kids = names.map((n, i) => kid(`bK${i}`, n));
  const M = emptyBoard("bFrames", "Course");
  kids.forEach((k, i) => {
    M.cards.push({ id: `f${i}`, kind: "board", board: k.id });
    M.place[`f${i}`] = { x: 80 + (i % 2) * 1500, y: 400 + Math.floor(i / 2) * 1100, w: 1200, h: 800 };
  });
  put(M, note("ft", "# Basic Concepts", "freetext"), 80, 80, 900);
  put(M, note("mk", "Parallel Pattern", "mark"), 1580, 120, 500);
  M.cam = { x: 20, y: 20, z: 0.6 };
  const run = await hostBoards([M, ...kids], {
    page: { light: true, w: 1280, h: 800, settings: { theme: "warm-ink" } },
  });
  const h = await run.open("bFrames");
  await until(h, "the frames draw their boards", () => h.page.locator(".card.board .skel [data-sub]").count());
  await idle(h);
  /** What a frame and the Free Text show, independent of the zoom */
  const looks = () =>
    h.page.evaluate(() => {
      const one = (id: string) => {
        const e = document.querySelector(`.card[data-id="${id}"]`) as HTMLElement,
          r = e.getBoundingClientRect(),
          name = e.querySelector(".sbname") as HTMLElement | null;
        return {
          lod: [...e.classList].filter((c) => c.startsWith("lo-")).join(),
          shown: getComputedStyle(e).visibility === "visible" && r.width > 0,
          name: name ? name.textContent : e.textContent?.trim(),
          cut: name ? name.scrollWidth > name.clientWidth + 1 : false,
          count: e.querySelector(".sbmeta")?.textContent ?? null,
          aspect: +(r.width / r.height).toFixed(2),
        };
      };
      return { f0: one("f0"), f3: one("f3"), ft: one("ft") };
    });
  const near = await looks();
  check(
    "summaryFramesOnlyBoard at 60 % the frames show their names and counts, the Mark shows",
    near.f0.count === "4" && !near.f0.cut && (await h.page.locator('.card[data-id="mk"]').isVisible()),
    near,
  );
  await wheelZoom(h, 900);
  await until(h, "the card level is gone", () => h.page.locator(".cardlay.gone").count());
  await idle(h);
  const far = await looks();
  check(
    "summaryFramesOnlyBoard past the cut a board with nothing to summarize hides its Marks too",
    !(await h.page.locator('.card[data-id="mk"]').isVisible()) && (await zoomOf(h)) < 0.3,
    { z: await zoomOf(h) },
  );
  check(
    "summaryFramesOnlyBoard the frames and the Free Text look as at 60 %, only scaled: no map look, names whole, counts kept",
    JSON.stringify(far) === JSON.stringify(near) && far.f0.lod === "" && far.ft.lod === "",
    { near, far },
  );
  await h.close();
});

test("summaryOverflowFades", async () => {
  const b = emptyBoard("bOv", "overflow");
  const long =
    "合并访存要求同一 warp 的线程访问**连续的地址**，这样一次事务就能取回整段数据，地址分散时要拆成很多次事务。".repeat(
      3,
    );
  put(b, note("a", "# 合并访存：连续地址\n\n同一 warp 访问连续地址。"), 80, 80, 700);
  put(b, note("b", "# 合并访存：对齐方式\n\n起始地址按 128 字节对齐。"), 80, 520, 700);
  put(b, note("far", "# 远处\n\n撑开白板"), 4200, 2600, 700);
  put(b, note("c", `# ${"共享内存的 bank 冲突与填充".repeat(6)}\n\n短。`), 1200, 80, 600);
  putSummary(b, "card:c", { text: "短。", at: Date.now(), sig: summarySig(b, "card:c")! });
  for (const k of ["card:a", "card:b"]) putSummary(b, k, { text: long, at: Date.now(), sig: summarySig(b, k)! });
  b.cam = { x: 40, y: 40, z: 0.2 };
  const h = await open({ board: b, w: 1280, h: 800, light: true });
  await idle(h);
  const A = h.page.locator('.sumcol[data-sum="card:a"]'),
    B = h.page.locator('.sumcol[data-sum="card:b"]');
  /** What shows of a column: its clip's bottom on screen, whether it is raised */
  const shown = (l: typeof A) =>
    l.evaluate((e) => {
      const r = e.getBoundingClientRect(),
        cs = getComputedStyle(e),
        rest = parseFloat(cs.getPropertyValue("--rest")),
        z = r.height / (e as HTMLElement).offsetHeight;
      // hovered, the clip opens past the column (inset(-3S)) for the panel around it
      const clipped = cs.clipPath !== "none" && !cs.clipPath.startsWith("inset(-");
      return {
        top: r.top,
        bottom: clipped ? r.top + rest * z : r.bottom,
        over: e.classList.contains("sumover"),
        mask: cs.maskImage !== "none",
        raised: cs.zIndex === "2",
      };
    });
  const a0 = await shown(A),
    b0 = await shown(B);
  await shot(h, "130-overflow-rest");
  check(
    "summaryOverflowFades at rest the upper column ends above the lower one and fades its last lines",
    a0.over && a0.mask && !a0.raised && a0.bottom < b0.top,
    { a0, b0 },
  );
  await A.locator(".sumhd").hover();
  await until(h, "the hovered column is raised", async () => (await shown(A)).raised);
  const a1 = await shown(A);
  await shot(h, "130-overflow-hover");
  check(
    "summaryOverflowFades hovered it shows its whole text over the lower column, unmasked; nothing else moved",
    !a1.mask && a1.bottom > b0.top && (await shown(B)).top === b0.top,
    { a1, b0 },
  );
  await h.page.mouse.move(1200, 780);
  await until(h, "it collapses on leave", async () => !(await shown(A)).raised);
  // a title longer than two lines: two lines and an ellipsis at rest, in full while hovered
  const C = h.page.locator('.sumcol[data-sum="card:c"]');
  const title = () =>
    C.evaluate((e) => {
      const t = e.querySelector(".sumhdi") as HTMLElement;
      return {
        lines: Math.round(t.clientHeight / parseFloat(getComputedStyle(t).lineHeight)),
        clamp: e.classList.contains("sumclamp"),
        raised: getComputedStyle(e).zIndex === "2",
      };
    });
  const c0 = await title();
  await C.locator(".sumhd").hover();
  await until(h, "the long title shows in full", async () => (await title()).lines > 2);
  const c1 = await title();
  check(
    "summaryOverflowFades a long title is two lines at rest and shows in full, raised, while hovered",
    c0.lines === 2 && c0.clamp && !c0.raised && c1.raised,
    { c0, c1 },
  );
  await h.page.mouse.move(1200, 780);
  await until(h, "the title is two lines again", async () => (await title()).lines === 2);
  await h.page.context().close();
});
