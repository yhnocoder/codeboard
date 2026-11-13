// Zoomed-out AI summaries (#130; core summary.ts, state/summary.ts, canvas/Summaries.tsx, host summaries.ts).
//   summaryDetentSwitch          the board's cut is a detent: a zoom out stops at it, and a small push raises the mist and fills
//                                the line without switching, draining once let go; pushed through, the mist covers the board, the
//                                card level is swapped for the summaries in one frame under it (no half-faded frame) with the seal
//                                stamped, and the mist clears; one column per top-level Section and loose card, anchored at its
//                                top-left; a Text and a Box stay as they are, at their own size; the zoom stops at
//                                the board's minimum; a push during the switch is held at the cut and the switch finishes first
//   summaryWrittenAndEdited      on the real host with a fake DeepSeek: opening the board asks nothing, ↻ writes one item (as
//                                long as its content asks, no layout numbers); a click edits a body in place (Enter saves, marked edited, kept as a pair
//                                with the AI text it replaced), ↻ rewrites it following that edit and keeps the pair, ⌘Z brings
//                                the hand edit back; ✓ 保留 on a stale one keeps it and clears its dot; a Note with no heading
//                                shows nothing until written, then the AI's short title, titles and bodies rendered inline (refs by name, highlights) with no syntax showing
//   summaryNoKey                 without a DeepSeek key nothing is written: Section titles with empty bodies, and ↻ says a key is needed
//   summaryOverflowFades         two loose cards stacked close, each with a long summary: at rest the columns never overlap and
//                                the upper one fades out over its last lines; hovered it shows in full over the lower one, raised;
//                                a title past two lines ends in an ellipsis and shows in full the same way
//   summaryNestedSections        Sections inside Sections, three deep (option G; the demo's 计算架构 nesting in one more Section):
//                                each innermost Section its own summary, an outer one a header above its frame (title, rule,
//                                overview: two lines on top, one deeper, the deeper header under the outer one), its direct cards
//                                one column with the AI's title, a Section with one child only a kick line above the child's title;
//                                nothing overlaps at rest; ↻ on a middle header asks the AI for its overview from its children
//   summaryFramesOnlyBoard       a board of sub-board frames, a Text heading and a Box, nothing to summarize: zoomed out past the
//                                cut the frames, the Text and the Box look as they do at 100 %, only scaled
//   summarySwitchWhole           a slow pinch out through the detent and back, sampled every frame: no card in view is ever blank
//                                while the card level shows, the card level is never taken out of the tree (its opacity alone
//                                hides it), the swap happens in one frame, with the summary columns complete and the mist covering
//                                the board on that frame and the one before; swapped out and at rest, the card level stays drawn
//                                under the summaries with the cards in view prepared, so the switch back opens on whole cards
//   zoomLogRecords               the host's Record Zoom Log: the first ask starts recording (null), a pinch past the cut is logged
//                                frame by frame (scale, pinch events, latency) with the switch's start and end, the summary
//                                layer's build, the cards in view with no content (none) and the faded card level kept drawn at
//                                rest, the second ask stops it and answers the log, headed with the cores and the dpr
import {
  emptyBoard,
  putSummary,
  summaryInput,
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

/** Three Sections of three Notes in a row (wide enough that the summary level is reachable), a loose Note, a Box and a Text */
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
  put(b, note("bx", "看这里", "box"), 2700, 1800, 300);
  put(b, note("ft", "随手写的一行", "text"), 4000, 1800, 600);
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
/** The swapped-out card level's opacity: kept drawn under the summaries, too low to show (state/summary.ts) */
const FADED = 0.003;
/** The detent's mist, line and seal (Canvas.tsx): the mist's height as a fraction of the viewport (0 = not up at all, ≥ 1 =
 *  covering the board), the line's fill, whether the seal is stamped and what it says */
const detentOf = (h: Host) =>
  h.page.evaluate(() => {
    const num = (s: string | undefined) => (s ? +s : NaN);
    const mist = document.querySelector(".cutmist") as HTMLElement,
      line = document.querySelector(".cutline i") as HTMLElement,
      seal = document.querySelector(".cutseal") as HTMLElement;
    return {
      mistOn: mist.classList.contains("on"),
      mist: num(/scaleY\(([\d.]+)\)/.exec(mist.style.transform)?.[1]),
      line: num(/scaleX\(([\d.]+)\)/.exec(line.style.transform)?.[1]),
      seal: seal.classList.contains("on") ? seal.textContent : null,
    };
  });

type Sample = {
  z: number;
  co: number;
  cv: string;
  so: number | null;
  cols: number;
  blank: string[];
  mist: number;
  seal: boolean;
};
/** Samples the two levels once per animation frame: the camera scale, the card level's opacity and content-visibility, the
 *  summary level's opacity and columns, the cards in view drawn with their content hidden (cull: .off, and not .far), and
 *  the detent's mist (its top, as detentOf) and seal */
const sampleFrames = (h: Host) =>
  h.page.evaluate(() => {
    const w = window as unknown as { __samples: Sample[]; __raf: number };
    w.__samples = [];
    const tick = () => {
      const world = document.querySelector(".world") as HTMLElement,
        lay = document.querySelector(".cardlay") as HTMLElement,
        sum = document.querySelector(".sumlay") as HTMLElement | null,
        mist = document.querySelector(".cutmist") as HTMLElement;
      const blank: string[] = [];
      for (const c of lay.querySelectorAll<HTMLElement>(".card.off:not(.far)")) {
        const r = c.getBoundingClientRect();
        if (r.right > 0 && r.left < innerWidth && r.bottom > 0 && r.top < innerHeight) blank.push(c.dataset.id!);
      }
      w.__samples.push({
        z: +(/scale\(([\d.e-]+)\)/.exec(world.style.transform)?.[1] ?? 1),
        co: +lay.style.opacity,
        cv: getComputedStyle(lay).contentVisibility,
        so: sum ? +sum.style.opacity : null,
        cols: document.querySelectorAll(".sumcol").length,
        blank,
        mist: mist.classList.contains("on") ? +(/scaleY\(([\d.]+)\)/.exec(mist.style.transform)?.[1] ?? 0) : 0,
        seal: document.querySelector(".cutseal")!.classList.contains("on"),
      });
      w.__raf = requestAnimationFrame(tick);
    };
    w.__raf = requestAnimationFrame(tick);
  });
const samples = (h: Host) =>
  h.page.evaluate(() => {
    const w = window as unknown as { __samples: Sample[]; __raf: number };
    cancelAnimationFrame(w.__raf);
    return w.__samples;
  });
/** The frame the card level was swapped out (its opacity left 1): the swap happened in one frame, under the mist, with the
 *  summary columns complete, and the mist still covered the board on the frame before */
function swapChecks(name: string, ss: Sample[]) {
  const i = ss.findIndex((x) => x.co < 1);
  const half = ss.filter((x) => x.co > 0.01 && x.co < 0.99);
  check(
    `${name} the levels swap in one frame under the mist, the summary columns complete: no half-faded frame`,
    i > 0 && ss[i].cols === 4 && ss[i].so === 1 && ss[i].mist >= 1 && ss[i - 1].mist >= 1 && !half.length,
    { at: ss[i], before: ss[i - 1], half: half.length },
  );
  check(
    `${name} the seal is stamped while the mist covers the board`,
    ss.some((x) => x.seal && x.mist >= 1),
    ss.filter((x) => x.mist >= 1).map((x) => x.seal),
  );
}

test("summaryDetentSwitch", async () => {
  const h = await open({ board: bigBoard("bSum", 1, true), w: 1280, h: 800, light: true });
  check(
    "summaryDetentSwitch at 100 % the cards show and the summary level is not built yet (it is, near the cut)",
    (await opacity(h, ".cardlay")) === 1 && (await h.page.locator(".sumlay").count()) === 0,
  );
  check(
    "summaryDetentSwitch a Text and a Box are in the layer that never fades",
    (await h.page.locator('.keeplay .card[data-id="ft"]').count()) === 1 &&
      (await h.page.locator('.keeplay .card[data-id="bx"]').count()) === 1,
  );
  // from just above the cut, a step that would cross it stops at it and pushes half-way (deltaY 30 is a zoom of e^-0.3; a push
  // is through at e^0.6): the mist is up by half its height, the line half full, no seal, the cards still there
  await wheelZoom(h, 100);
  const above = await zoomOf(h);
  await wheelZoom(h, 30);
  const cut = await zoomOf(h);
  const half = await detentOf(h);
  check(
    "summaryDetentSwitch a small push stops at the cut: the mist rises and the line fills by the push, the cards stay",
    cut > 0.2 &&
      cut <= 0.3 &&
      cut < above &&
      half.mistOn &&
      // read a moment after the push: it may have begun to drain (SUMMARY.detent.drainAfter), the mist and line together
      half.line > 0.3 &&
      half.line <= 0.5 &&
      Math.abs(half.mist - half.line * 0.55) < 0.02 &&
      half.seal === null &&
      (await h.page.locator(".cardlay.gone").count()) === 0,
    { cut, above, half },
  );
  // let go: the push drains and the mist goes back down
  await until(h, "the push has drained", async () => !(await detentOf(h)).mistOn);
  check(
    "summaryDetentSwitch let go, the push drains: the mist is gone, the zoom still at the cut, the cards still there",
    (await zoomOf(h)) === cut && (await h.page.locator(".cardlay.gone").count()) === 0,
  );
  // through: the mist covers the board, the levels swap under it, the mist clears
  await sampleFrames(h);
  await wheelZoom(h, 600);
  await until(h, "the card level is gone", () => h.page.locator(".cardlay.gone").count());
  await until(h, "the mist has cleared", async () => !(await detentOf(h)).mistOn);
  const out = await samples(h);
  swapChecks("summaryDetentSwitch", out);
  const z = await zoomOf(h);
  check(
    "summaryDetentSwitch through the detent the zoom is just across the cut, the mist cleared, the summaries showing",
    z < cut && z > cut * 0.8 && (await opacity(h, ".sumlay")) === 1 && (await opacity(h, ".cardlay")) <= FADED,
    { z, cut },
  );
  const keys = await h.page
    .locator(".sumcol")
    .evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.sum).sort());
  check(
    "summaryDetentSwitch one column per Section and loose card, none for the Text or the Box",
    keys.join() === "card:loose,sec:s0,sec:s1,sec:s2",
    keys,
  );
  const s0 = await h.page.locator('.sumcol[data-sum="sec:s0"]').evaluate((e) => {
    // the layer is laid out at 1 / K of the board and scaled up by K (Summaries.tsx K): back to board units
    const st = (e as HTMLElement).style,
      K = +(/scale\(([\d.]+)\)/.exec((e.closest(".sumlay") as HTMLElement).style.transform)?.[1] ?? 1),
      px = (v: string) => Math.round(parseFloat(v) * K * 100) / 100;
    return { x: px(st.left), y: px(st.top), b: e.querySelector(".sumtx :is(b, strong)")?.textContent };
  });
  check(
    "summaryDetentSwitch a Section's column starts at its frame's top-left, with its key phrase bold",
    s0.x === 80 && s0.y === 80 && s0.b === "吞吐量",
    s0,
  );
  const ft = h.page.locator('.card[data-id="ft"]');
  await idle(h);
  check(
    "summaryDetentSwitch the Text and the Box keep their look and their own size",
    (await opacity(h, ".cardlay")) === FADED &&
      (await h.page.locator('.card[data-id="bx"]').isVisible()) &&
      (await ft.isVisible()) &&
      (await h.page.locator(".keeplay").evaluate((e) => getComputedStyle(e).opacity)) === "1" &&
      (await ft.evaluate((e) => e.querySelector(".tx")?.textContent === "随手写的一行")),
    await ft.evaluate((e) => e.className),
  );
  // the board's minimum zoom: fit-all ÷ 1.3, so zooming further out does nothing
  await wheelZoom(h, 600);
  const z1 = await zoomOf(h);
  await wheelZoom(h, 600);
  const z2 = await zoomOf(h);
  check("summaryDetentSwitch the zoom stops at the board's minimum", z2 === z1 && z1 < cut && z1 > 0.05, { z1, z2 });
  // back in through the detent, and a push out again while the switch runs: held at the cut, the switch finishes at the cards;
  // the next push goes back through
  await wheelZoom(h, -600);
  await wheelZoom(h, 150);
  await until(h, "the cards are back", async () => (await h.page.locator(".cardlay.gone").count()) === 0);
  await until(h, "the mist has cleared after the switch back", async () => !(await detentOf(h)).mistOn);
  const zb = await zoomOf(h);
  check(
    "summaryDetentSwitch a push during the switch is held at the cut: the switch finishes at the cards, just across the cut",
    (await h.page.locator(".cardlay.gone").count()) === 0 &&
      zb > cut &&
      zb < cut * 1.2 &&
      (await opacity(h, ".cardlay")) === 1,
    { zb, cut },
  );
  await wheelZoom(h, 150);
  await until(h, "the summaries are back", () => h.page.locator(".cardlay.gone").count());
  check("summaryDetentSwitch the next push goes back through", (await zoomOf(h)) < cut);
  await h.page.context().close();
});

/** A pinch: ctrl + wheel in small steps, one per frame, until the condition holds (dy > 0: out) */
async function pinch(h: Host, dy: number, done: () => Promise<boolean>) {
  const v = h.page.viewportSize()!;
  await h.page.mouse.move(v.width / 2, v.height / 2);
  await h.page.keyboard.down("Control");
  for (let i = 0; i < 120 && !(await done()); i++) {
    await h.page.mouse.wheel(0, dy);
    await h.page.evaluate(() => new Promise((r) => requestAnimationFrame(r)));
  }
  await h.page.keyboard.up("Control");
}
const gone = (h: Host) =>
  h.page.evaluate(() => document.querySelector(".cardlay")?.classList.contains("gone") ?? false);
const mistOn = (h: Host) => h.page.evaluate(() => document.querySelector(".cutmist")!.classList.contains("on"));

test("summarySwitchWhole", async () => {
  const h = await open({ board: bigBoard("bSwitch", 1, true), w: 1280, h: 800, light: true });
  await idle(h);
  // at 100 % only part of the first Section is in view: the other cards have their content hidden (cull) and come into view
  // during the zoom out, under the switch
  const hidden0 = await h.page.locator(".cardlay .card.off").count();
  check("summarySwitchWhole at 100 % the cards out of view have their content hidden", hidden0 >= 6, hidden0);
  await sampleFrames(h);
  // a pinch of 6 a frame pushes through the detent in ten frames or so, then zooms on
  await pinch(h, 6, async () => (await gone(h)) && !(await mistOn(h)) && (await zoomOf(h)) < 0.2);
  await idle(h);
  const out = await samples(h);
  const rest = out.at(-1)!;
  const blankShown = (ss: Sample[]) => ss.filter((s) => s.co > 0.05 && s.blank.length).map((s) => [s.z, s.co, s.blank]);
  check(
    "summarySwitchWhole no card in view is blank while the card level shows (zoom out)",
    !blankShown(out).length,
    blankShown(out),
  );
  check(
    "summarySwitchWhole the card level is never taken out of the tree (zoom out)",
    out.every((s) => s.cv === "visible"),
    out.filter((s) => s.cv !== "visible").length,
  );
  swapChecks("summarySwitchWhole", out);
  const held = out.filter((s) => s.co === 1 && s.mist < 1 && s.mist > 0 && !s.seal);
  check(
    "summarySwitchWhole the pinch is held at the cut while it pushes, the mist rising with it",
    held.length >= 3 && held.every((s) => Math.abs(s.z - held[0].z) < 1e-6) && held.at(-1)!.mist > held[0].mist,
    { held: held.length, z: held.map((s) => s.z.toFixed(4)), mist: held.map((s) => s.mist.toFixed(2)) },
  );
  check(
    "summarySwitchWhole swapped out and at rest, the card level stays drawn under the summaries with the cards in view prepared",
    rest.co === 0.003 && rest.so === 1 && rest.blank.length === 0 && rest.cv === "visible",
    rest,
  );
  await sampleFrames(h);
  await pinch(h, -6, async () => !(await gone(h)) && !(await mistOn(h)) && (await zoomOf(h)) > 0.6);
  await idle(h);
  const back = await samples(h);
  const open0 = back.find((s) => s.co > 0.003);
  check(
    "summarySwitchWhole the switch back opens on whole cards, under the mist, and never takes the level out of the tree",
    !!open0 &&
      open0.co === 1 &&
      open0.mist >= 1 &&
      open0.blank.length === 0 &&
      back.every((s) => s.cv === "visible") &&
      back.at(-1)!.co === 1,
    { open0, last: back.at(-1) },
  );
  check(
    "summarySwitchWhole no card in view is blank while the card level shows (zoom in)",
    !blankShown(back).length,
    blankShown(back),
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
  // written before its cards changed: stale (the dot), but asked for only after a change in this session
  putSummary(b, "sec:s2", { text: "线程调度的旧摘要。", at: Date.now(), sig: "before the change" });
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
  // ✓ 保留 beside ↻ on the stale one keeps its text, counts it as written from these cards and clears its dot
  const s2 = h.page.locator('.sumcol[data-sum="sec:s2"]');
  const marks = () =>
    s2.evaluate((e) => ({
      dot: getComputedStyle(e.querySelector(".sumdot")!).display !== "none",
      keep: e.querySelectorAll(".sumkp").length,
    }));
  await s2.locator(".sumhd").hover();
  await s2.locator(".sumkp").waitFor();
  const stale = await marks();
  await shot(h, "130-keep-summary");
  await s2.locator(".sumkp").click();
  await until(h, "保留 is saved", () => !!h.board().sections.find((s) => s.id === "s2")?.summary?.input);
  const kept = await marks();
  check(
    "summaryWrittenAndEdited 保留 keeps a stale summary as it is and clears its dot",
    stale.dot &&
      stale.keep === 1 &&
      !kept.dot &&
      kept.keep === 0 &&
      summaryIn(h, "s2")?.text === "线程调度的旧摘要。" &&
      summaryIn(h, "s2")?.sig === summarySig(h.board(), "sec:s2") &&
      calls.length === 0,
    { stale, kept, s2: summaryIn(h, "s2") },
  );
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
  put(M, note("ft", "# Basic Concepts", "text"), 80, 80, 900);
  put(M, note("mk", "Parallel Pattern", "box"), 1580, 120, 500);
  M.cam = { x: 20, y: 20, z: 0.6 };
  const run = await hostBoards([M, ...kids], {
    page: { light: true, w: 1280, h: 800, settings: { theme: "warm-ink" } },
  });
  const h = await run.open("bFrames");
  await until(h, "the frames draw their boards", () => h.page.locator(".card.board .skel [data-sub]").count());
  await idle(h);
  /** What a frame, the Text and the Box show, independent of the zoom */
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
      return { f0: one("f0"), f3: one("f3"), ft: one("ft"), mk: one("mk") };
    });
  const near = await looks();
  check(
    "summaryFramesOnlyBoard at 60 % the frames show their names and counts, the Box shows",
    near.f0.count === "4" && !near.f0.cut && (await h.page.locator('.card[data-id="mk"]').isVisible()),
    near,
  );
  await wheelZoom(h, 900);
  await until(h, "the card level is gone", () => h.page.locator(".cardlay.gone").count());
  await idle(h);
  const far = await looks();
  check(
    "summaryFramesOnlyBoard past the cut the card level fades, the Box stays",
    (await opacity(h, ".cardlay")) === FADED &&
      (await h.page.locator('.card[data-id="mk"]').isVisible()) &&
      (await zoomOf(h)) < 0.3,
    { z: await zoomOf(h), cardlay: await opacity(h, ".cardlay") },
  );
  check(
    "summaryFramesOnlyBoard the frames, the Text and the Box look as at 60 %, only scaled: no map look, names whole, counts kept",
    JSON.stringify(far) === JSON.stringify(near) && far.f0.lod === "" && far.ft.lod === "" && far.mk.lod === "",
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
  // the paper panel hugs what the column holds (0.6·S past it on every side), never the column's free room below
  const panelOf = (l: typeof A) =>
    l.evaluate((e) => {
      const S = parseFloat(getComputedStyle(e.closest(".sumlay")!).getPropertyValue("--S")),
        cs = getComputedStyle(e),
        pad = parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom),
        p = getComputedStyle(e, "::before");
      return {
        drawn: p.content !== "none" && p.content !== "normal",
        panel: parseFloat(p.height),
        content: (e.querySelector(".sumblk") as HTMLElement).offsetHeight + pad + 1.2 * S,
      };
    });
  await until(h, "the panel has faded in", async () =>
    A.evaluate((e) => getComputedStyle(e, "::before").opacity === "1"),
  );
  const pa = await panelOf(A);
  check(
    "summaryOverflowFades the hover panel of a cut text is as tall as the column's content plus its padding",
    pa.drawn && Math.abs(pa.panel - pa.content) < 4,
    pa,
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
  const pc = await panelOf(C);
  check(
    "summaryOverflowFades a column whose text fits shows no paper panel on hover",
    !pc.drawn && !(await C.evaluate((e) => e.classList.contains("sumover"))),
    pc,
  );
  check(
    "summaryOverflowFades a long title is two lines at rest and shows in full, raised, while hovered",
    c0.lines === 2 && c0.clamp && !c0.raised && c1.raised,
    { c0, c1 },
  );
  await h.page.mouse.move(1200, 780);
  await until(h, "the title is two lines again", async () => (await title()).lines === 2);
  await h.page.context().close();
});

/** The demo's 计算架构 board (feedback/demo/nested-sections.html), short Notes in the same places, both its outer Sections in one
 *  more (计算架构): GPU 架构初探 holds three Sections and five cards of its own, WARP 执行 three Sections; 设备与资源 holds only
 *  查询设备属性. Written as in the demo */
function nestedBoard(id: string, z: number): Board {
  const b = emptyBoard(id, "计算架构与调度");
  const S = (sid: string, title: string, parent?: string): Section => ({
    id: sid,
    title,
    x: 0,
    y: 0,
    w: 0,
    h: 0,
    ...(parent ? { parent } : {}),
  });
  b.sections.push(
    S("T", "计算架构"),
    S("P", "GPU 架构初探", "T"),
    S("c1", "SM 与 block 调度", "P"),
    S("c2", "barrier 与透明扩展", "P"),
    S("c3", "__syncthreads 误用示例", "P"),
    S("W", "WARP 执行", "T"),
    S("w1", "WARP 与 SIMD 硬件", "W"),
    S("w2", "WARP 控制流分歧", "W"),
    S("w3", "WARP 调度、延迟、占用率", "W"),
    S("D", "设备与资源"),
    S("q", "查询设备属性", "D"),
  );
  const cards: [string, string, number, number, number, string][] = [
    ["c1", "现代 GPU 的架构", 63, 25, 524, "GPU 由一组高度多线程化的 SM 组成。"],
    ["c1", "thread block 调度", 617, 25, 498, "block 整块分给一个 SM。"],
    ["c2", "同步与透明可扩展性", 1203, 25, 517, "同一 block 的线程用 barrier 协调。"],
    ["c2", "barrier 应尽量限制在较小范围", 1203, 692, 524, "范围越大，等待越多。"],
    ["c3", "错误使用 __syncthreads() 的示例", 2382, 671, 292, "if 和 else 各放一个。"],
    ["P", "thread block cluster", 1807, 25, 404, "cluster 范围的 barrier。"],
    ["P", "grid 范围同步", 1807, 228, 404, "开销高于 block 和 cluster。"],
    ["P", "Intrinsic Function", 1807, 413, 404, "__syncthreads 是 intrinsic。"],
    ["P", "__syncthreads tricky 的地方", 1807, 648, 517, "每处调用都是独立的同步点。"],
    ["P", "Wave", 1807, 983, 476, "同时执行的一组 block。"],
    ["w1", "Warp", 1703, 1700, 476, "32 个线程一组。"],
    ["w1", "线程布局", 2258, 1700, 476, "row-major 展平再切。"],
    ["w1", "GPU 中的 SIMD 硬件设计", 1703, 2558, 476, "一条指令跑整个 warp。"],
    ["w2", "Wrap 控制流分歧", 2994, 1700, 381, "分支要分遍跑。"],
    ["w2", "检查是否会造成控制流分歧", 3635, 1700, 480, "看判定条件。"],
    ["w2", "控制流分歧: if-else", 2845, 2206, 387, "两边各跑一遍。"],
    ["w3", "Warp 调度与延迟容忍", 2808, 2902, 517, "等内存时换一个 warp。"],
    ["w3", "资源划分与占用率", 2808, 3626, 381, "occupancy。"],
    ["w3", "性能悬崖初探", 3698, 3626, 417, "多用一个寄存器就掉一截。"],
    ["q", "查询设备属性", 4542, 2902, 380, "cudaGetDeviceProperties。"],
    ["q", "使用 cudaDeviceProp", 4261, 3297, 450, "按资源上限调参。"],
  ];
  cards.forEach(([sec, title, x, y, w, text], i) => {
    put(b, note(`k${i}`, `## ${title}\n\n${text}`), x, y, w);
    b.place[`k${i}`].section = sec;
  });
  // a frame is its stored box grown to what it holds: store a point inside it (its first card's corner)
  const inside = (sid: string): string =>
    cards.find((c) => c[0] === sid)?.[0] ?? inside(b.sections.find((x) => x.parent === sid)!.id);
  for (const sec of b.sections) {
    const c = cards.find((k) => k[0] === inside(sec.id))!;
    Object.assign(sec, { x: c[2], y: c[3] });
  }
  const written = (k: string, text: string, title?: string) =>
    putSummary(b, k, {
      text,
      at: Date.now(),
      sig: summarySig(b, k)!,
      input: summaryInput(b, k),
      ...(title ? { title } : {}),
    });
  written(
    "sec:c1",
    "线程以 **thread block 为单位**分到 SM，同一 block 的线程落在同一个 SM 上，能用 barrier 和 shared memory **低延迟协作**。",
  );
  written("sec:c2", "barrier 只限在 block 内，不同 block 就能按任意顺序执行，程序在大小不同的 GPU 上**透明扩展**。");
  written("sec:c3", "if 和 else 两边各放一个 __syncthreads()，其实是**两个同步点**，行为未定义。");
  written("sec:w1", "block 按 32 个线程切成 **warp**，是 SM 的调度单位；SIMD 让一条指令同时跑整个 warp。");
  written("sec:w2", "同一 warp 的线程走不同分支时，硬件要**分遍执行**，每遍只有部分线程活动。");
  written("sec:w3", "一个 warp 等内存时调度器**零开销**切到另一个，靠 warp 多来盖住延迟。");
  written("sec:q", "每个设备的资源由**计算能力**决定，查 SM 数、每 block 线程上限等资源上限。");
  written(
    "own:P",
    "barrier 分三层：block 内用 __syncthreads()，cluster 和 grid 用 Cooperative Groups，**范围越大开销越高**。同时执行的一批 block 叫 wave。",
    "同步层次与 wave",
  );
  written("sec:P", "SM 按块调度，barrier 只在块内，**换来透明扩展**。");
  written("sec:W", "warp 一起跑、分支分遍跑，靠**多驻留 warp** 盖住延迟。");
  written("sec:T", "SM 按 block 调度、barrier 只在块内，warp 是执行单位：**两层调度**决定了并行怎么写。");
  b.cam = { x: 40, y: 190, z };
  return b;
}

test("summaryNestedSections", async () => {
  const run = await hostBoards([nestedBoard("bN", 0.14)], {
    page: { light: true, w: 1280, h: 800, settings: { theme: "warm-ink" } },
  });
  const { calls } = await fakeDeepseek(run, () => "块内同步**换来透明扩展**，SM 按 block 调度。");
  const h = await run.open("bN");
  await idle(h);
  const cols = () =>
    h.page.evaluate(() =>
      [...document.querySelectorAll<HTMLElement>(".sumcol")].map((e) => {
        // the layer is laid out at 1 / K of the board and scaled up by K (Summaries.tsx K): back to board units
        const K = +(/scale\(([\d.]+)\)/.exec((e.closest(".sumlay") as HTMLElement).style.transform)?.[1] ?? 1),
          px = (v: string) => Math.round(parseFloat(v) * K * 100) / 100;
        return {
          key: e.dataset.sum!,
          cls: e.className,
          x: px(e.style.left),
          y: px(e.style.top),
          w: px(e.style.width),
          h: px(e.style.getPropertyValue("--rest")),
          title: e.querySelector(".sumt")?.textContent ?? "",
          kick: e.querySelector(".sumkick")?.textContent ?? "",
          re: !!e.querySelector(".sumre"),
          text: e.querySelector(".sumtx")?.textContent ?? "",
        };
      }),
    );
  const frame = (id: string) =>
    h.page
      .locator(`.sect[data-sect="${id}"]`)
      .evaluate((e) => ({ x: parseFloat((e as HTMLElement).style.left), y: parseFloat((e as HTMLElement).style.top) }));
  const all = await cols();
  const by = (k: string) => all.find((c) => c.key === k);
  await shot(h, "130-nested");
  check(
    "summaryNestedSections innermost Sections summarized, outer ones a header (level 1 on top, level 2 inside it, each with its overview and ↻), the direct cards one column with the AI's title, a one-child Section a kick line",
    ["sec:c1", "sec:c2", "sec:c3", "sec:w1", "sec:w2", "sec:w3", "sec:q"].every(
      (k) => by(k) && !/\bh[12]\b/.test(by(k)!.cls),
    ) &&
      /\bh1\b/.test(by("sec:T")?.cls ?? "") &&
      /\bh2\b/.test(by("sec:P")?.cls ?? "") &&
      /\bh2\b/.test(by("sec:W")?.cls ?? "") &&
      ["sec:T", "sec:P", "sec:W"].every((k) => by(k)?.re && by(k)?.text.includes("**") === false && !!by(k)?.text) &&
      by("own:P")?.title === "同步层次与 wave" &&
      !by("sec:D") &&
      by("sec:q")?.kick === "设备与资源 ›",
    all.map((c) => [c.key, c.cls, c.title, c.kick]),
  );
  const fP = await frame("P"),
    fW = await frame("W");
  const P = by("sec:P")!,
    W = by("sec:W")!,
    T = by("sec:T")!;
  const hit = all.flatMap((a, i) =>
    all
      .slice(i + 1)
      .filter((c) => a.x < c.x + c.w && c.x < a.x + a.w && a.y < c.y + c.h && c.y < a.y + a.h)
      .map((c) => `${a.key} / ${c.key}`),
  );
  check(
    "summaryNestedSections the headers sit above their frames, at their left edges, the outer one on top of the deeper one; nothing overlaps at rest",
    Math.abs(P.x - fP.x) < 1 &&
      P.y + P.h <= fP.y &&
      Math.abs(W.x - fW.x) < 1 &&
      W.y + W.h <= fW.y &&
      T.y + T.h <= P.y &&
      !hit.length,
    { P, fP, W, fW, T, hit },
  );
  await h.page.locator('.sumcol[data-sum="sec:P"] .sumhd').hover();
  await h.page.locator('.sumcol[data-sum="sec:P"] .sumre').click();
  await until(h, "↻ asked for the overview", () => calls.length === 1);
  await until(
    h,
    "the overview is in the host's board",
    () =>
      !!h
        .board()
        .sections.find((s) => s.id === "P")
        ?.summary?.text.startsWith("块内同步"),
  );
  const asked = calls[0].body.messages[1].content as string;
  check(
    "summaryNestedSections ↻ on a middle header asks for one sentence from its children's titles and summaries and its direct cards",
    asked.includes("外层 Section 标题：GPU 架构初探") &&
      asked.includes("**透明扩展**") &&
      asked.includes("【Wave】") &&
      !asked.includes("WARP"),
    asked,
  );
  await h.close();
});

test("zoomLogRecords", async () => {
  const h = await open({ board: bigBoard("bZoomLog", 1, true), w: 1280, h: 800, light: true });
  await idle(h);
  type Answer = Extract<BoardToHost, { type: "answer" }>;
  const toggle = async (id: number) => {
    await h.post({ type: "zoomLog", id });
    return (
      await until(h, `the board answers zoomLog ${id}`, () =>
        h.sent.find((m): m is Answer => m.type === "answer" && m.id === id),
      )
    ).value;
  };
  check("zoomLogRecords the first ask starts recording", (await toggle(1)) === null);
  await wheelZoom(h, 600);
  await until(h, "the card level is gone", () => h.page.locator(".cardlay.gone").count());
  await until(h, "the mist has cleared", async () => !(await mistOn(h)));
  await idle(h);
  const log = await toggle(2);
  const lines = typeof log === "string" ? log.split("\n") : [];
  check(
    "zoomLogRecords the log is headed with the cores and the device pixel ratio",
    /^# cores \d+ dpr [\d.]+ /.test(lines[1] ?? ""),
    lines.slice(0, 3),
  );
  check(
    "zoomLogRecords a frame line carries the pinch that arrived before it and its latency",
    lines.some((l) => /^f [\d.]+ [\d.]+ z[\d.]+ p1 [\d.]+$/.test(l)),
    lines.filter((l) => l.startsWith("f ")).slice(0, 6),
  );
  check(
    "zoomLogRecords the switch's start and end and the summary layer's build are logged",
    lines.some((l) => /^S [\d.]+ 0→1 start/.test(l)) &&
      lines.some((l) => /^S [\d.]+ 1 end/.test(l)) &&
      lines.some((l) => /^B [\d.]+ [\d.]+ layer, cols \d+\/\d+$/.test(l)) &&
      lines.some((l) => /^S [\d.]+ 1 swap frame [\d.]+$/.test(l)),
    lines.filter((l) => /^[SB] /.test(l)),
  );
  check(
    "zoomLogRecords no card in view had its content hidden, and at rest the faded card level was kept drawn",
    lines.some((l) => /^X [\d.]+ none$/.test(l)) &&
      !lines.some((l) => /^X [\d.]+ (?!none)/.test(l)) &&
      lines.some((l) => /^W [\d.]+ card level kept drawn z[\d.]+$/.test(l)),
    lines.filter((l) => /^[XW] /.test(l)),
  );
  check("zoomLogRecords asked again it records anew", (await toggle(3)) === null);
  check("zoomLogRecords and stops with a log of its own", typeof (await toggle(4)) === "string");
});
