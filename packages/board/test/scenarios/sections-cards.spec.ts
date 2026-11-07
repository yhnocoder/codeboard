import { shot, symCard, findSym, put, type Host } from "../harness";
import { DEFAULT_SETTINGS, emptyBoard, sectionFrame, type Board, type NoteCard, type Rect } from "@codeboard/core";
import { test, open, check, light, until, idle, hold } from "../fixtures";
import { watch } from "../watch";
import { WHEEL_GESTURE } from "../../src/state/timing";

const close = (h: Host) => h.page.context().close();

/** Two Sections side by side: a code card in the left one, a Note with a heading in the right one */
function twoSections(): Board {
  const b = emptyBoard("b1", "nano-vllm · sections");
  const s = findSym("Scheduler.schedule");
  const code = symCard(s.f, s.s);
  put(b, code, 100, 110, 480);
  const note: NoteCard = {
    id: "n1",
    kind: "note",
    look: "note",
    md: "# KV cache budget\n\nPrefill first, then decode.",
  };
  put(b, note, 760, 110, 320);
  b.sections.push({ id: "S1", title: "异构并行计算", x: 60, y: 60, w: 560, h: 760 });
  b.sections.push({ id: "S2", title: "Scheduling", x: 720, y: 60, w: 520, h: 420 });
  b.place[code.id].section = "S1";
  b.place.n1.section = "S2";
  return b;
}

/** Section frame: a solid hairline (no dashes), no pill behind the title, handle and caret only on hover; selected = accent */
test("sectionLook", async () => {
  const h = await open({ board: twoSections(), light });
  await h.page.keyboard.press("Shift+!");
  await idle(h);
  await h.page.mouse.move(1380, 880);
  await idle(h);
  const look = () =>
    h.page.evaluate(() => {
      const f = document.querySelector('.sect[data-sect="S2"]')!,
        l = document.querySelector('.slabel[data-sect="S2"]')!;
      const fs = getComputedStyle(f),
        ls = getComputedStyle(l);
      const op = (sel: string) => {
        const e = l.querySelector(sel);
        return e ? +getComputedStyle(e).opacity : -1;
      };
      return {
        border: fs.borderTopStyle,
        radius: parseFloat(fs.borderTopLeftRadius),
        cardRadius: parseFloat(getComputedStyle(document.querySelector(".card")!).borderTopLeftRadius),
        labelBg: ls.backgroundColor,
        dots: op(".dots"),
        chev: op(".chev2"),
        shadow: fs.boxShadow,
      };
    });
  const rest = await look();
  await shot(h, "sect-look-01-idle");
  await h.page.locator('.slabel[data-sect="S2"] .sname').hover();
  await idle(h); // the handle and caret fade in
  const hover = await look();
  await shot(h, "sect-look-02-hover");
  await h.page.locator('.slabel[data-sect="S2"] .sname').click();
  await h.page.locator('.sect.sel[data-sect="S2"], .slabel.sel[data-sect="S2"]').first().waitFor();
  await idle(h);
  const selected = await look();
  await shot(h, "sect-look-03-selected");
  const clear = (c: string) => c === "rgba(0, 0, 0, 0)" || c === "transparent";
  check(
    "section-look-idle",
    rest.border !== "dashed" &&
      rest.radius <= rest.cardRadius + 2 &&
      clear(rest.labelBg) &&
      rest.dots === 0 &&
      rest.chev === 0,
    rest,
  );
  check("section-look-hover", hover.dots > 0.9 && hover.chev > 0.9, hover);
  check("section-look-selected", selected.shadow !== rest.shadow, { idle: rest.shadow, selected: selected.shadow });
  await close(h);
});

/** Section ▸ Fit Content: the frame tightens to its member cards plus the standard padding (22 at the sides and bottom, 34 at the top
 *  for the title), animated; one undo step brings the old frame back */
test("sectionFitContent", async () => {
  const b = emptyBoard("b1", "fit section");
  put(
    b,
    { id: "a", kind: "note", look: "note", md: "# Prefill\n\nChecks the free KV blocks." } as NoteCard,
    240,
    220,
    300,
  );
  put(b, { id: "c", kind: "note", look: "note", md: "# Decode\n\nOne token per step." } as NoteCard, 600, 300, 260);
  b.sections.push({ id: "S", title: "Scheduling", x: 80, y: 60, w: 1100, h: 760 });
  b.place.a.section = "S";
  b.place.c.section = "S";
  b.cam = { x: 0, y: 0, z: 1 };
  const h = await open({ board: b, light, w: 1300, h: 900 });
  await idle(h);
  await shot(h, "sect-fit-01-before");
  await h.page.locator('.slabel[data-sect="S"] .sname').click({ button: "right" });
  await h.page.locator(".ctx:not(.closing) button").first().waitFor();
  await idle(h);
  const items = await h.page.locator(".ctx:not(.closing) button").allTextContents();
  check(
    "sectionFitContent in the Section menu",
    items.some((t) => t.includes("Fit Content")),
    { items },
  );
  if (!items.some((t) => t.includes("Fit Content"))) return;
  const w0 = (await h.page.locator('.sect[data-sect="S"]').boundingBox())!.width;
  await h.page.locator(".ctx:not(.closing) button", { hasText: "Fit Content" }).click();
  const samples = await h.page.evaluate(
    () =>
      new Promise<number[]>((res) => {
        const el = document.querySelector('.sect[data-sect="S"]')!,
          out: number[] = [];
        const f = () => {
          out.push(el.getBoundingClientRect().width);
          if (out.length < 30) requestAnimationFrame(f);
          else res(out);
        };
        requestAnimationFrame(f);
      }),
  );
  await until(h, "Fit Content is saved", () => h.board().sections[0].w !== 1100);
  await idle(h);
  const got = await h.page.evaluate(() => {
    const r = (s: string) => document.querySelector(s)!.getBoundingClientRect();
    const f = r('.sect[data-sect="S"]'),
      a = r('.card[data-id="a"]'),
      c = r('.card[data-id="c"]');
    const want = {
      l: Math.min(a.left, c.left) - 22,
      t: Math.min(a.top, c.top) - 34,
      r: Math.max(a.right, c.right) + 22,
      b: Math.max(a.bottom, c.bottom) + 22,
    };
    return { frame: { l: f.left, t: f.top, r: f.right, b: f.bottom }, want };
  });
  const w1 = got.frame.r - got.frame.l;
  const mid = samples.filter((v) => v < w0 - 2 && v > w1 + 2).length;
  const s = h.board().sections[0];
  await shot(h, "sect-fit-02-after");
  const near = (x: number, y: number) => Math.abs(x - y) < 1.5;
  check(
    "sectionFitContent wraps its members",
    near(got.frame.l, got.want.l) &&
      near(got.frame.t, got.want.t) &&
      near(got.frame.r, got.want.r) &&
      near(got.frame.b, got.want.b) &&
      near(s.x, got.want.l) &&
      near(s.y, got.want.t) &&
      near(s.w, w1),
    { got, s },
  );
  check("sectionFitContent animated", mid >= 3, { w0, w1, samples });
  await h.page.keyboard.press("ControlOrMeta+z");
  await until(h, "the undo is saved", () => h.board().sections[0].w !== s.w);
  await idle(h);
  const back = h.board().sections[0];
  check("sectionFitContent one undo step", back.x === 80 && back.y === 60 && back.w === 1100 && back.h === 760, {
    back,
  });
  await close(h);
});

/** A collapsed Section is a compact pill: the title in bold, "· N cards" in grey and a small caret at the right end. Hovering it shows a few of its cards
 *  (kind icon and title, two columns) and "+N more". The caret is one small icon that turns when the Section expands */
test("sectionCollapsedPill", async () => {
  const b = emptyBoard("b1", "collapsed section");
  const s = findSym("Scheduler.schedule");
  const code = symCard(s.f, s.s);
  put(b, code, 120, 140, 480);
  const titles = ["Prefill", "Decode", "Preemption", "Block manager", "Prefix cache", "KV budget", "Sampling"];
  titles.forEach((t, i) =>
    put(
      b,
      { id: `n${i}`, kind: "note", look: "note", md: `# ${t}\n\nNotes.` } as NoteCard,
      660 + (i % 2) * 300,
      140 + Math.floor(i / 2) * 160,
      260,
    ),
  );
  for (const id of Object.keys(b.place)) b.place[id].section = "S";
  b.sections.push({ id: "S", title: "异构并行计算", x: 80, y: 80, w: 1200, h: 800, collapsed: true });
  b.cam = { x: 0, y: 0, z: 1 };
  const h = await open({ board: b, light, w: 900, h: 600 });
  await idle(h);
  await h.page.mouse.move(800, 550);
  const pill = '.slabel[data-sect="S"]';
  const look = await h.page.evaluate((sel) => {
    const p = document.querySelector(sel)!,
      n = p.querySelector<HTMLElement>(".sname")!,
      c = p.querySelector(".scount");
    const pr = p.getBoundingClientRect(),
      cr = c?.getBoundingClientRect();
    return {
      name: n.textContent,
      weight: +getComputedStyle(n).fontWeight,
      clipped: n.scrollWidth > n.clientWidth + 1,
      count: c?.textContent?.replace(/\s+/g, " ").trim(),
      countInside: !!cr && cr.right <= pr.right + 0.5,
      countGrey: !!c && getComputedStyle(c).color !== getComputedStyle(n).color,
    };
  }, pill);
  await shot(h, "sect-pill-01-collapsed");
  check(
    "sectionCollapsedPill title and count",
    look.name === "异构并行计算" &&
      look.weight >= 600 &&
      !look.clipped &&
      look.count === "· 8 cards" &&
      look.countInside &&
      look.countGrey,
    look,
  );
  // hover: a preview of a few member cards, each with its kind icon, then "+N more"
  // the preview shows PEEK_DELAY after the pointer comes onto the pill (a timer): wait for it, then for its fade-in
  await h.page.locator(`${pill} .sname`).hover();
  await h.page.locator(`${pill} .spv`).waitFor({ timeout: 5000 });
  await idle(h);
  const pv = await h.page.evaluate((sel) => {
    const v = document.querySelector(`${sel} .spv`);
    if (!v) return null;
    const rows = [...v.querySelectorAll(".spv-i")].map((r) => ({
      icon: !!r.querySelector("svg"),
      text: r.textContent?.trim(),
    }));
    return { rows, more: v.querySelector(".spv-more")?.textContent?.trim(), opacity: +getComputedStyle(v).opacity };
  }, pill);
  await shot(h, "sect-pill-02-hover-preview");
  const shownTitles = pv?.rows.map((r) => r.text) ?? [];
  check(
    "sectionCollapsedPill hover preview",
    !!pv &&
      pv.opacity > 0.9 &&
      pv.rows.length === 5 &&
      pv.rows.every((r) => r.icon) &&
      shownTitles.every((t) => !!t && [...titles, "Scheduler.schedule"].some((x) => t.includes(x))) &&
      pv.more === "+3 more",
    pv,
  );
  await h.page.mouse.move(800, 550);
  await h.page.locator(`${pill} .spv`).waitFor({ state: "detached", timeout: 5000 });
  await idle(h);
  const gone = await h.page.evaluate((sel) => {
    const v = document.querySelector(`${sel} .spv`);
    return !v || +getComputedStyle(v).opacity < 0.05;
  }, pill);
  check("sectionCollapsedPill preview hides", gone);
  // the caret: one small icon, pointing right while collapsed and down once expanded (it turns)
  const angle = () =>
    h.page.evaluate((sel) => {
      const i = document.querySelector(`${sel} .chev2 svg`);
      if (!i) return null;
      // the turn, from the rotate property or the transform
      const cs = getComputedStyle(i),
        rot = cs.rotate && cs.rotate !== "none" ? parseFloat(cs.rotate) : 0;
      const m = new DOMMatrix(cs.transform === "none" ? "" : cs.transform);
      return {
        deg: Math.round(rot + (Math.atan2(m.b, m.a) * 180) / Math.PI),
        size: Math.min(i.getBoundingClientRect().width, i.getBoundingClientRect().height),
      };
    }, pill);
  const a0 = await angle();
  // collapsed or not, the caret is at the right end: after the card count (it jumped to the left on collapsing)
  const right = await h.page.evaluate((sel) => {
    const n = document.querySelector(`${sel} .scount`)!.getBoundingClientRect(),
      c = document.querySelector(`${sel} .chev2`)!.getBoundingClientRect();
    return c.left - n.right;
  }, pill);
  await h.page.locator(`${pill} .chev2`).click();
  await until(h, "expanding is saved", () => !h.board().sections[0].collapsed);
  await idle(h);
  await h.page.locator(`${pill} .sname`).hover();
  await idle(h);
  const a1 = await angle();
  const gap = await h.page.evaluate((sel) => {
    const n = document.querySelector(`${sel} .sname`)!.getBoundingClientRect(),
      c = document.querySelector(`${sel} .chev2`)!.getBoundingClientRect();
    return c.left - n.right;
  }, pill);
  await shot(h, "sect-pill-03-expanded-hover");
  check(
    "sectionCollapsedPill caret turns",
    !!a0 &&
      !!a1 &&
      a0.size <= 12 &&
      Math.abs(a1.deg - a0.deg) === 90 &&
      gap >= 0 &&
      gap < 10 &&
      right >= 0 &&
      right < 10,
    { a0, a1, gap, right },
  );
  await close(h);
});

/** Folding and unfolding a Section with its animation (member cards are built and taken down over a few frames, the far-off ones
 *  after the animation): folded, no member card is left in the page and the Section is the same kind of frame as an open one, just
 *  wrapping its title; the arrow from a card outside stays on the page the whole time and ends on the folded frame at the title row;
 *  nothing jumps when the animation stops; unfolded, every member is back where it was, with nothing left of the animation, the
 *  far-off member included; one undo folds it again */
test("sectionFoldRoundTrip", async () => {
  const b = emptyBoard("b1", "fold round trip");
  const s = findSym("Scheduler.schedule");
  const code = symCard(s.f, s.s);
  put(b, code, 120, 140, 480);
  ["Prefill", "Decode", "Preemption"].forEach((t, i) =>
    put(b, { id: `n${i}`, kind: "note", look: "note", md: `# ${t}\n\nNotes.` } as NoteCard, 680, 140 + i * 180, 280),
  );
  // 离屏幕很远的一张：展开时动画放完才建
  put(b, { id: "far", kind: "note", look: "note", md: "# Far away\n\nNotes." } as NoteCard, 9000, 6000, 280);
  for (const id of Object.keys(b.place)) b.place[id].section = "S";
  const ids = Object.keys(b.place);
  // Section 外面一张卡，连着一张成员卡：折叠、展开时这条线一直在，终点跟着框走；Section 里两张卡之间的线跟着卡收进去
  put(b, { id: "out", kind: "note", look: "note", md: "# Outside\n\nNotes." } as NoteCard, 9600, 140, 280);
  b.links.push(
    { id: "L", from: { card: "out" }, to: { card: "n0" } },
    { id: "In", from: { card: "n1" }, to: { card: "n2" } },
  );
  b.sections.push({ id: "S", title: "Scheduling", x: 80, y: 80, w: 9400, h: 6400 });
  b.cam = { x: 0, y: 0, z: 1 };
  const h = await open({ board: b, light, w: 1400, h: 900 });
  await idle(h);
  const before = await h.page.evaluate(() =>
    Object.fromEntries(
      [...document.querySelectorAll<HTMLElement>(".card[data-id]")].map((e) => [
        e.dataset.id,
        e.getBoundingClientRect().toJSON(),
      ]),
    ),
  );
  const cards = () =>
    h.page.evaluate(
      (ids) =>
        ids.map((id) => {
          const e = document.querySelector<HTMLElement>(`.card[data-id="${id}"]`);
          return (
            e && {
              id,
              anim: e.style.transform + e.style.translate + e.style.scale + e.style.opacity,
              skel: e.matches(".skel, .skel-in") || !!e.querySelector(".skl"),
              r: e.getBoundingClientRect().toJSON(),
            }
          );
        }),
      ids,
    );
  // 框和标题的样子：折叠后和展开时一样（同样的底色、边框，标题没有自己的底）
  const look = () =>
    h.page.evaluate(() => {
      const f = document.querySelector<HTMLElement>('.sect[data-sect="S"]'),
        l = document.querySelector<HTMLElement>('.slabel[data-sect="S"]')!;
      const fs = f && getComputedStyle(f),
        ls = getComputedStyle(l);
      return {
        frame: fs && {
          bg: fs.backgroundColor,
          border: fs.borderTopColor + " " + fs.borderTopWidth + " " + fs.borderTopStyle,
          r: f!.getBoundingClientRect().toJSON(),
        },
        label: {
          bg: ls.backgroundColor,
          shadow: ls.boxShadow,
          weight: ls.fontWeight,
          r: l.getBoundingClientRect().toJSON(),
        },
      };
    });
  // 动画的每一帧记下：框、外面连进来的线（在不在、透明度、终点）、「· N cards」
  const record = () =>
    h.page.evaluate(() => {
      const w = window as any;
      w.__rec = [];
      w.__recOn = true;
      const tick = () => {
        if (!w.__recOn) return;
        const f = document.querySelector('.sect[data-sect="S"]')?.getBoundingClientRect(),
          p = document.querySelector<SVGPathElement>('g.link[data-lk="L"] path.edge');
        let op = p ? 1 : 0;
        for (let e: Element | null = p; e && e.tagName !== "svg"; e = e.parentElement)
          op *= +getComputedStyle(e).opacity;
        const n =
          p
            ?.getAttribute("d")
            ?.match(/-?[\d.]+/g)
            ?.map(Number) ?? [];
        w.__rec.push({
          f: f && [f.x, f.y, f.width, f.height],
          op,
          end: n.slice(-2),
          count: !!document.querySelector('.slabel[data-sect="S"] .scount'),
        });
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });
  type Rec = { f: number[] | null; op: number; end: number[]; count: boolean };
  const stop = () =>
    h.page.evaluate(() => {
      const w = window as any;
      w.__recOn = false;
      return w.__rec as Rec[];
    });
  // 动画停下那一帧：框和线的终点最后一次变化不到一个半像素（弹簧收紧了才停，停下时不跳）
  const lastStep = (rec: Rec[]) => {
    let f = 0,
      e = 0;
    for (let i = 1; i < rec.length; i++) {
      const a = rec[i - 1],
        b = rec[i];
      const df = a.f && b.f ? Math.max(...b.f.map((x, j) => Math.abs(x - a.f![j]))) : 0,
        de = a.end.length && b.end.length ? Math.max(Math.abs(b.end[0] - a.end[0]), Math.abs(b.end[1] - a.end[1])) : 0;
      if (df > 0.01) f = df;
      if (de > 0.01) e = de;
    }
    return { frame: f, end: e };
  };
  const open0 = await look();
  await record();
  await h.page.locator('.slabel[data-sect="S"] button[aria-label="Collapse Section"]').click();
  await until(h, "the fold is saved", () => h.board().sections[0].collapsed);
  await idle(h);
  const recFold = await stop();
  const folded = await cards(),
    shut = await look();
  check(
    "sectionFoldRoundTrip folded: no member card left",
    folded.every((c) => !c),
    folded,
  );
  const lr = shut.label.r,
    fr = shut.frame?.r;
  check(
    "sectionFoldRoundTrip folded: the same frame and title as an open Section, the frame just wraps the title",
    !!shut.frame &&
      !!fr &&
      shut.frame.bg === open0.frame!.bg &&
      shut.frame.border === open0.frame!.border &&
      shut.label.bg === open0.label.bg &&
      shut.label.shadow === open0.label.shadow &&
      shut.label.weight === open0.label.weight &&
      lr.x === open0.label.r.x &&
      lr.y === open0.label.r.y &&
      fr.x === open0.frame!.r.x &&
      fr.y === open0.frame!.r.y &&
      lr.right <= fr.right &&
      lr.right > fr.right - 16 &&
      lr.bottom <= fr.bottom &&
      fr.height < 40,
    { open0, shut },
  );
  const endF = recFold[recFold.length - 1].end;
  check(
    "sectionFoldRoundTrip folding: the outside arrow stays, ends on the folded frame at the title row, the card count shows from the start",
    recFold.length > 10 &&
      recFold.every((r) => r.op > 0.99) &&
      !!fr &&
      Math.abs(endF[0] - fr.right) < 10 &&
      Math.abs(endF[1] - (lr.y + lr.height / 2)) < 2 &&
      recFold.filter((r) => r.f && open0.frame && r.f[2] < open0.frame.r.width - 1).every((r) => r.count),
    { frames: recFold.length, ops: [...new Set(recFold.map((r) => r.op))], endF, fr, lr },
  );
  check(
    "sectionFoldRoundTrip folding: nothing jumps when it stops",
    lastStep(recFold).frame < 1.5 && lastStep(recFold).end < 1.5,
    lastStep(recFold),
  );
  await record();
  await h.page.locator('.slabel[data-sect="S"] .chev2').click();
  await until(h, "the unfold is saved", () => !h.board().sections[0].collapsed);
  // idle() 不够：动画停下后还有几帧不变；等真正动完（far 也建好、内容淡回来）
  const open1 = await until(h, "every member card is back and done moving", async () => {
    const cs = await cards();
    return cs.every((c) => c && !c.anim && !c.skel) && cs;
  }).catch(() => cards());
  await idle(h);
  const recUnfold = await stop();
  const near = (a: DOMRect, b: DOMRect) => Math.abs(a.x - b.x) < 1 && Math.abs(a.y - b.y) < 1;
  check(
    "sectionFoldRoundTrip unfolded: every member back, nothing left of the animation",
    open1.every((c) => !!c && !c.anim && !c.skel) &&
      open1.filter((c) => c && before[c.id]).every((c) => near(c!.r, before[c!.id])),
    { open1, before },
  );
  const back = await look();
  const arrow = await h.page.locator('g.link[data-lk="L"]').count(),
    inner = await h.page.evaluate(() => {
      const g = document.querySelector('g.link[data-lk="In"]')?.parentElement;
      return g ? { t: g.getAttribute("transform"), op: getComputedStyle(g).opacity } : null;
    });
  check(
    "sectionFoldRoundTrip unfolded: the frame, both arrows and the title back as they were",
    arrow === 1 &&
      !!inner &&
      !inner.t &&
      inner.op === "1" &&
      JSON.stringify(back.frame) === JSON.stringify(open0.frame) &&
      back.label.r.width === open0.label.r.width,
    { arrow, inner, back, open0 },
  );
  check(
    "sectionFoldRoundTrip unfolding: the outside arrow stays, nothing jumps when it stops",
    recUnfold.every((r) => r.op > 0.99) && lastStep(recUnfold).frame < 1.5 && lastStep(recUnfold).end < 1.5,
    {
      ops: [...new Set(recUnfold.map((r) => r.op))],
      last: lastStep(recUnfold),
      tail: recUnfold
        .map((r) => r.end.map(Math.round).join(","))
        .filter((x, i, a) => x !== a[i - 1])
        .slice(-12),
    },
  );
  await h.page.keyboard.press("ControlOrMeta+z");
  await until(h, "the undo is saved", () => h.board().sections[0].collapsed);
  await idle(h);
  const undone = await cards();
  check(
    "sectionFoldRoundTrip undo folds again",
    undone.every((c) => !c),
    undone,
  );
  await close(h);
});

/** A Note grows while its Section is collapsed (a larger Note font in the settings); revealing it expands the Section and frames the
 *  Note by its new height, not the one measured before the collapse */
test("revealFramesRegrownCard", async () => {
  const b = emptyBoard("b1", "reveal regrown");
  const md = Array.from({ length: 8 }, (_, i) => `Line ${i + 1} of the Note`).join("\n\n");
  put(b, { id: "n", kind: "note", look: "note", md } as NoteCard, 2600, 1800, 420);
  b.place.n.section = "S";
  b.sections.push({ id: "S", title: "Far", x: 2560, y: 1740, w: 500, h: 900 });
  b.cam = { x: 0, y: 0, z: 1 };
  const h = await open({ board: b, light, w: 1400, h: 900 });
  await idle(h);
  const short = await h.page.locator('.card[data-id="n"]').evaluate((e) => (e as HTMLElement).offsetHeight);
  await h.post({ type: "merged", patch: { sections: { set: [{ ...b.sections[0], collapsed: true }] } } });
  await h.page.locator('.card[data-id="n"]').waitFor({ state: "detached" });
  await h.post({
    type: "host",
    host: { settings: { ...DEFAULT_SETTINGS, noteFontSize: { ...DEFAULT_SETTINGS.noteFontSize, body: 40 } } },
  });
  await h.post({ type: "reveal", card: "n" });
  await h.page.locator('.card[data-id="n"]').waitFor();
  await idle(h);
  const r = await h.page.locator('.card[data-id="n"]').evaluate((e) => {
    const c = e.getBoundingClientRect();
    return { top: Math.round(c.top), bottom: Math.round(c.bottom), h: Math.round(c.height), vh: innerHeight };
  });
  await shot(h, "reveal-regrown");
  check("revealFramesRegrownCard", r.h > short * 1.8 && r.top >= 0 && r.bottom <= r.vh, { ...r, short });
  await close(h);
});

/** Drag a card by its title bar from one Section into another: the target Section lights up during the drag, the card joins it, one undo puts it back */
test("dragCardIntoOtherSection", async () => {
  const h = await open({ board: twoSections(), light });
  await h.page.keyboard.press("Shift+!");
  await idle(h);
  const head = (await h.page.locator('.card[data-id="n1"] .chead').boundingBox())!;
  const card = (await h.page.locator('.card[data-id="n1"]').boundingBox())!;
  const s1 = (await h.page.locator('.sect[data-sect="S1"]').boundingBox())!;
  const s2a = (await h.page.locator('.sect[data-sect="S2"]').boundingBox())!;
  const grab = { x: head.x + 40, y: head.y + head.height / 2 };
  // put the card's centre in the lower part of S1, below the code card
  const to = { x: s1.x + s1.width / 2, y: s1.y + s1.height - card.height / 2 - 30 };
  const dx = to.x - (card.x + card.width / 2),
    dy = to.y - (card.y + card.height / 2);
  await h.page.mouse.move(grab.x, grab.y);
  await h.page.mouse.down();
  await h.page.mouse.move(grab.x + dx / 2, grab.y + dy / 2, { steps: 6 });
  await h.page.mouse.move(grab.x + dx, grab.y + dy, { steps: 10 });
  await idle(h);
  const during = await h.page.evaluate(() =>
    [...document.querySelectorAll(".sect.drop, .slabel.drop")].map((e) => (e as HTMLElement).dataset.sect),
  );
  const s2b = (await h.page.locator('.sect[data-sect="S2"]').boundingBox())!;
  await shot(h, "sect-drag-01-over-target");
  await h.page.mouse.up();
  await idle(h); // the drop is sent at once
  const after = h.board().place.n1.section;
  const lit = await h.page.locator(".sect.drop").count();
  await shot(h, "sect-drag-02-dropped");
  check("drag-into-section-highlight", during.includes("S1") && !during.includes("S2"), { during });
  // the Section the card leaves keeps its own frame during the drag instead of stretching after the card
  check("drag-source-section-stays", Math.abs(s2b.height - s2a.height) < 2 && Math.abs(s2b.width - s2a.width) < 2, {
    before: s2a,
    during: s2b,
  });
  check("drag-into-section-joins", after === "S1" && lit === 0, { after, lit });
  await h.page.keyboard.press("ControlOrMeta+z");
  await idle(h);
  check("drag-into-section-undo", h.board().place.n1.section === "S2", { section: h.board().place.n1.section });
  // the same move from the card menu: Move to Section ▸ 异构并行计算 (the card lands inside that Section's frame)
  await h.page.locator('.card[data-id="n1"] .chead').click({ button: "right" });
  await h.page.locator(".ctx:not(.closing) button", { hasText: "Move to Section" }).hover();
  await h.page.locator(".ctx:not(.closing) button", { hasText: "异构并行计算" }).waitFor();
  await shot(h, "sect-menu-01-move-to");
  await h.page.locator(".ctx:not(.closing) button", { hasText: "异构并行计算" }).click();
  await until(h, "Move to Section saves the card in S1", () => h.board().place.n1.section !== "S2");
  await idle(h);
  const p = h.board().place.n1,
    f = (await h.page.locator('.sect[data-sect="S1"]').boundingBox())!,
    c = (await h.page.locator('.card[data-id="n1"]').boundingBox())!;
  await shot(h, "sect-menu-02-moved");
  check(
    "move-to-section-menu",
    p.section === "S1" &&
      p.y >= 60 &&
      p.y <= 820 &&
      c.x >= f.x &&
      c.x + c.width <= f.x + f.width &&
      c.y >= f.y &&
      c.y + c.height <= f.y + f.height + 1,
    { p, f, c },
  );
  await close(h);
});

/** A drag that comes to rest is looked at again this long after its last move, as a slow one, so it snaps (interact.ts snapPace) */
const SNAP_SETTLE = 110;
/** Dragging a Section by its label aligns it with other Sections like a card drag: slowed down near another Section's edge it
 *  snaps onto it and a guide line shows; holding Ctrl turns snapping off. The cards inside move along; one undo puts it back */
test("sectionDragSnapsToSection", async () => {
  const b = emptyBoard("b1", "section snapping");
  put(b, { id: "a", kind: "note", look: "note", md: "Prefill" } as NoteCard, 120, 140, 220);
  put(b, { id: "c", kind: "note", look: "note", md: "Decode" } as NoteCard, 660, 500, 200);
  b.sections.push({ id: "S1", title: "Scheduling", x: 60, y: 60, w: 400, h: 300 });
  b.sections.push({ id: "S2", title: "KV cache", x: 600, y: 420, w: 320, h: 220 });
  b.place.a.section = "S1";
  b.place.c.section = "S2";
  b.cam = { x: 0, y: 0, z: 1 };
  const h = await open({ board: b, light, settings: { theme: "warm-ink" } as any });
  await idle(h);
  const box = async (id: string) => (await h.page.locator(`.sect[data-sect="${id}"]`).boundingBox())!;
  const s1 = await box("S1"),
    s2 = await box("S2");
  const label = (await h.page.locator('.slabel[data-sect="S2"] .sname').boundingBox())!;
  const grab = { x: label.x + 10, y: label.y + label.height / 2 };
  // S2's left edge to 4px right of S1's left edge, its top 40px lower (no horizontal edge or centre line within reach)
  const dx = s1.x + 4 - s2.x,
    dy = 40;
  const guides = () =>
    h.page.evaluate(() =>
      [...document.querySelectorAll(".guides .guide")].map((g) => {
        const r = g.getBoundingClientRect();
        return { v: g.classList.contains("v"), x: r.x, y: r.y, h: r.height };
      }),
    );
  const card0 = { ...h.board().place.c };
  // what the drag moves (S2's frame and title, its card) and what it leaves (S1, its card): compositor layer hint and look
  const layers = () =>
    h.page.evaluate(() =>
      [
        '.sect[data-sect="S2"]',
        '.slabel[data-sect="S2"]',
        '.card[data-id="c"]',
        '.sect[data-sect="S1"]',
        '.card[data-id="a"]',
      ].map((q) => {
        const e = document.querySelector(q)!,
          st = getComputedStyle(e);
        return {
          layer: st.willChange,
          look: [st.scale, st.zIndex, getComputedStyle(e, "::after").boxShadow].join(" | "),
        };
      }),
    );
  const still = await layers();
  await h.page.mouse.move(grab.x, grab.y);
  await h.page.mouse.down();
  await h.page.mouse.move(grab.x + dx / 2, grab.y + dy / 2, { steps: 8 });
  await h.page.mouse.move(grab.x + dx, grab.y + dy, { steps: 12 });
  await hold(h, SNAP_SETTLE + 100, "the pointer rests past the drag's settle delay: it snaps now if it is going to");
  await idle(h);
  const during = await guides(),
    s2d = await box("S2"),
    held = await layers();
  await shot(h, "sect-snap-01-guide");
  await h.page.mouse.up();
  await until(h, "the Section's move is saved", () => h.board().sections.find((q) => q.id === "S2")!.x !== 600);
  await idle(h);
  const down = await layers();
  // Dragged, the Section's frame, its title and its card are each a layer of its own (styles.css .carry), so a move only moves
  // those layers instead of painting them again in the world's layer; nothing of them looks different, and put down they are
  // back in the world's layer
  check(
    "sectionDragCarriesLayers",
    held.map((l) => l.layer).join() === "transform,transform,transform,auto,auto" &&
      down.every((l) => l.layer === "auto") &&
      held.every((l, i) => l.look === still[i].look),
    { still, held, down },
  );
  const sec2 = h.board().sections.find((q) => q.id === "S2")!,
    card1 = h.board().place.c;
  const left = (await box("S2")).x,
    gone = (await guides()).length;
  await shot(h, "sect-snap-02-dropped");
  const v = during.find((g) => g.v);
  check(
    "section-drag-guide",
    !!v && Math.abs(v.x - s1.x) < 1.5 && v.y <= s1.y + 1 && v.y + v.h >= s2d.y + s2d.height - 1,
    { during, s1, s2d },
  );
  check(
    "section-drag-snaps",
    Math.abs(s2d.x - s1.x) < 0.5 && Math.abs(left - s1.x) < 0.5 && sec2.x === 60 && sec2.y === 460 && gone === 0,
    { s2d, left, sec2, gone },
  );
  check("section-drag-moves-cards", card1.x === card0.x + (sec2.x - 600) && card1.y === card0.y + 40, { card0, card1 });
  await h.page.keyboard.press("ControlOrMeta+z");
  await until(h, "the undo is saved", () => h.board().sections.find((q) => q.id === "S2")!.x !== sec2.x);
  await idle(h);
  const back = h.board().sections.find((q) => q.id === "S2")!;
  check("section-drag-undo", back.x === 600 && back.y === 420 && h.board().place.c.x === card0.x, {
    back,
    c: h.board().place.c,
  });
  // Ctrl held: no snapping, no guide
  const label2 = (await h.page.locator('.slabel[data-sect="S2"] .sname').boundingBox())!;
  const g2 = { x: label2.x + 10, y: label2.y + label2.height / 2 };
  await h.page.mouse.move(g2.x, g2.y);
  await h.page.mouse.down();
  await h.page.keyboard.down("Control");
  await h.page.mouse.move(g2.x + dx, g2.y + dy, { steps: 12 });
  await hold(h, SNAP_SETTLE + 100, "the pointer rests past the drag's settle delay: with Ctrl it still must not snap");
  await idle(h);
  const free = await guides();
  await h.page.mouse.up();
  await h.page.keyboard.up("Control");
  await until(h, "the Section's move is saved", () => h.board().sections.find((q) => q.id === "S2")!.x !== 600);
  await idle(h);
  const sec3 = h.board().sections.find((q) => q.id === "S2")!;
  check("section-drag-ctrl-no-snap", free.length === 0 && sec3.x === 64, { free, sec3 });
  await close(h);
});

/** Membership is by overlap: a card belongs to a Section covering more than a third of its area; several → the one covering most.
 *  A wide card a bit under half inside joins (the Section lights up during the drag); a card about a quarter inside stays out;
 *  a card over two Sections joins the one it overlaps more */
test("sectionMembershipByOverlap", async () => {
  const b = emptyBoard("b1", "membership");
  put(b, { id: "c1", kind: "note", look: "note", md: "A quarter inside" } as NoteCard, 100, 620, 200);
  put(b, { id: "m1", kind: "note", look: "note", md: "Over two Sections" } as NoteCard, 100, 760, 400);
  put(
    b,
    { id: "w1", kind: "note", look: "note", md: "# A wide card\n\nA bit under half of it inside." } as NoteCard,
    560,
    560,
    560,
  );
  b.sections.push({ id: "S", title: "Scheduling", x: 600, y: 100, w: 400, h: 300 });
  b.sections.push({ id: "T", title: "Memory", x: 1100, y: 100, w: 400, h: 300 });
  b.cam = { x: 0, y: 0, z: 1 };
  const h = await open({ board: b, light, w: 1600 });
  await idle(h);
  const size = (id: string) =>
    h.page.evaluate((i) => {
      const r = document.querySelector(`.card[data-id="${i}"]`)!.getBoundingClientRect();
      return { w: r.width, h: r.height };
    }, id);
  const share = (
    p: { x: number; y: number },
    r: { w: number; h: number },
    f: { x: number; y: number; w: number; h: number },
  ) =>
    (Math.max(0, Math.min(p.x + r.w, f.x + f.w) - Math.max(p.x, f.x)) *
      Math.max(0, Math.min(p.y + r.h, f.y + f.h) - Math.max(p.y, f.y))) /
    (r.w * r.h);
  const S = b.sections[0],
    T = b.sections[1];
  const move = async (id: string, tx: number, ty: number, name?: string) => {
    const p0 = h.board().place[id];
    const dx = tx - p0.x,
      dy = ty - p0.y;
    const hd = (await h.page.locator(`.card[data-id="${id}"] .chead`).boundingBox())!;
    const x = hd.x + 30,
      y = hd.y + hd.height / 2;
    await h.page.mouse.move(x, y);
    await h.page.mouse.down();
    await h.page.mouse.move(x + dx / 2, y + dy / 2, { steps: 6 });
    await h.page.mouse.move(x + dx, y + dy, { steps: 8 });
    await idle(h);
    const lit = await h.page.evaluate(() =>
      [...document.querySelectorAll(".sect.drop")].map((e) => (e as HTMLElement).dataset.sect),
    );
    if (name) await shot(h, name);
    await h.page.mouse.up();
    await idle(h); // the drop is sent at once
    const p = h.board().place[id],
      r = await size(id);
    return { p, lit, s: share(p, r, S), t: share(p, r, T) };
  };
  // about a quarter inside S (and a quarter inside T): stays out
  const q = await move("c1", 950, 150, "27-third-01-quarter-inside");
  check("overlap-quarter-stays-out", q.s < 1 / 3 && q.t < 1 / 3 && q.s > 0.15 && !q.p.section && !q.lit.length, q);
  await h.page.keyboard.press("ControlOrMeta+z");
  await idle(h);
  // over two Sections, more than a third in each: joins the one it overlaps more
  const two = await move("m1", 840, 150, "27-third-02-over-two-sections");
  check(
    "overlap-two-sections-more-wins",
    two.s > 1 / 3 &&
      two.t > 1 / 3 &&
      two.p.section === (two.s > two.t ? "S" : "T") &&
      two.lit.length === 1 &&
      two.lit[0] === two.p.section,
    two,
  );
  await h.page.keyboard.press("ControlOrMeta+z");
  await idle(h);
  // wide card a bit under half inside: joins, and the Section lights up during the drag
  const w = await move("w1", 740, 250, "27-third-03-wide-card-over-section");
  await shot(h, "27-third-04-wide-card-joined");
  check(
    "overlap-under-half-joins",
    w.p.section === "S" && w.s > 0.4 && w.s < 0.5 && w.lit.length === 1 && w.lit[0] === "S",
    w,
  );
  await close(h);
});

/** Dragging a card inside a Section: the frame eases toward its new size (a spring the board drives, no CSS transition on its rect),
 *  its title stays on the drawn frame, and once the drag is over the frame ends exactly on its target. With reduced motion it snaps */
test("sectionFrameEasesToTarget", async () => {
  const b = emptyBoard("b1", "section easing");
  put(b, { id: "a", kind: "note", look: "note", md: "Prefill" } as NoteCard, 200, 210, 220);
  b.sections.push({ id: "S1", title: "Scheduling", x: 160, y: 160, w: 400, h: 300 });
  b.place.a.section = "S1";
  b.cam = { x: 0, y: 0, z: 1 };
  const h = await open({ board: b, light, settings: { theme: "warm-ink" } as any });
  await idle(h);
  const rectNow = () =>
    h.page.evaluate(() => {
      const f = document.querySelector<HTMLElement>('.sect[data-sect="S1"]')!,
        l = document.querySelector<HTMLElement>('.slabel[data-sect="S1"]')!;
      const c = document.querySelector<HTMLElement>('.card[data-id="a"]')!;
      const rects = document
        .getAnimations()
        .filter(
          (a) =>
            a instanceof CSSTransition &&
            /^(left|top|width|height)$/.test(a.transitionProperty) &&
            (a.effect as KeyframeEffect).target?.closest(".sect, .slabel"),
        );
      // the frame as drawn: laid out at its style's rect, scaled from there while it eases (canvas/Sections.tsx)
      const m = new DOMMatrix(getComputedStyle(f).transform === "none" ? undefined : getComputedStyle(f).transform);
      return {
        x: parseFloat(f.style.left) + m.e,
        y: parseFloat(f.style.top) + m.f,
        w: parseFloat(f.style.width) * m.a,
        h: parseFloat(f.style.height) * m.d,
        lx: parseFloat(l.style.left),
        ly: parseFloat(l.style.top),
        rectTransitions: rects.length,
        card: { x: c.offsetLeft, y: c.offsetTop, w: c.offsetWidth, h: c.offsetHeight },
      };
    });
  // the frame on the next frame after one pointer step: drawn once per animation frame, so read it after a rAF
  const afterFrame = () => h.page.evaluate(() => new Promise<void>((r) => requestAnimationFrame(() => r())));
  const want = (r: { card: Rect }) => sectionFrame(b.sections[0], [r.card]);
  const head = (await h.page.locator('.card[data-id="a"] .chead').boundingBox())!;
  const grab = { x: head.x + 30, y: head.y + head.height / 2 };
  const r0 = await rectNow();
  await h.page.mouse.move(grab.x, grab.y);
  await h.page.mouse.down();
  await h.page.mouse.move(grab.x, grab.y + 20, { steps: 4 });
  // one long step up and left, the card still mostly inside: the Section's target grows about 60 up and left at once
  await h.page.mouse.move(grab.x - 80, grab.y - 50);
  await afterFrame();
  const mid = await rectNow(),
    midWant = want(mid);
  await shot(h, "sect-ease-01-mid-drag");
  const between = (v: number, a: number, z: number) => v < Math.max(a, z) - 1 && v > Math.min(a, z) + 1;
  check(
    "section-ease-mid-drag",
    between(mid.x, r0.x, midWant.x) &&
      between(mid.y, r0.y, midWant.y) &&
      between(mid.h, r0.h, midWant.h) &&
      mid.rectTransitions === 0,
    { r0, mid, midWant },
  );
  // the title sits on the drawn frame, not on the target
  check("section-ease-label-follows", mid.lx === mid.x && mid.ly === mid.y, mid);
  // back where the drag started, and frame by frame while the frame eases back: the drawn frame moves every frame, but it is
  // laid out again (a whole re-raster of its layer) only now and then; in between a transform on a layer of its own scales it
  await h.page.mouse.move(grab.x, grab.y + 20);
  const eased = await h.page.evaluate(
    () =>
      new Promise<{ laid: string; drawn: string; layer: string }[]>((done) => {
        const f = document.querySelector<HTMLElement>('.sect[data-sect="S1"]')!,
          out: { laid: string; drawn: string; layer: string }[] = [];
        const step = () => {
          const r = f.getBoundingClientRect();
          out.push({
            laid: `${f.style.left} ${f.style.top} ${f.style.width} ${f.style.height}`,
            drawn: `${r.x.toFixed(1)} ${r.y.toFixed(1)} ${r.width.toFixed(1)} ${r.height.toFixed(1)}`,
            layer: getComputedStyle(f).willChange,
          });
          if (out.length < 24) requestAnimationFrame(step);
          else done(out);
        };
        requestAnimationFrame(step);
      }),
  );
  const changes = (k: "laid" | "drawn") => eased.filter((e, i) => i && e[k] !== eased[i - 1][k]).length;
  check(
    "section-ease-scales-not-relaid",
    changes("drawn") >= 5 &&
      changes("laid") <= changes("drawn") / 2 &&
      eased.slice(0, 4).every((e) => e.layer === "transform"),
    { laid: changes("laid"), drawn: changes("drawn"), eased },
  );
  await h.page.mouse.move(grab.x - 80, grab.y - 50);
  await h.page.mouse.up();
  await until(h, "the drag is saved", () => h.board().place.a.y !== 210);
  await idle(h);
  const end = await rectNow(),
    p = h.board().place.a,
    endWant = want(end);
  await shot(h, "sect-ease-02-dropped");
  check(
    "section-ease-ends-on-target",
    p.section === "S1" &&
      end.y < r0.y - 20 &&
      end.x === endWant.x &&
      end.y === endWant.y &&
      end.w === endWant.w &&
      end.h === endWant.h &&
      end.card.x === p.x &&
      end.card.y === p.y &&
      end.lx === end.x &&
      end.ly === end.y,
    { end, endWant, p },
  );
  // reduced motion: the frame is on its target right after the step
  await h.page.emulateMedia({ reducedMotion: "reduce" });
  const hd2 = (await h.page.locator('.card[data-id="a"] .chead').boundingBox())!;
  const g2 = { x: hd2.x + 30, y: hd2.y + hd2.height / 2 };
  await h.page.mouse.move(g2.x, g2.y);
  await h.page.mouse.down();
  await h.page.mouse.move(g2.x, g2.y + 20, { steps: 4 });
  await h.page.mouse.move(g2.x, g2.y + 60);
  await afterFrame();
  const snap = await rectNow(),
    snapWant = want(snap);
  await h.page.mouse.up();
  await idle(h);
  check(
    "section-ease-reduced-motion-snaps",
    snap.x === snapWant.x &&
      snap.y === snapWant.y &&
      snap.w === snapWant.w &&
      snap.h === snapWant.h &&
      snap.y > end.y + 20,
    { snap, snapWant },
  );
  await close(h);
});

/** A Note whose Markdown starts with a heading shows the heading as its title; a title set by the user wins; no heading = "Note" */
test("noteTitleFromHeading", async () => {
  const b = emptyBoard("b1", "titles");
  put(
    b,
    { id: "n1", kind: "note", look: "note", md: "## KV cache **budget**\n\nPrefill first." } as NoteCard,
    80,
    80,
    300,
  );
  put(b, { id: "n2", kind: "note", look: "note", md: "Just a paragraph, no heading." } as NoteCard, 440, 80, 300);
  put(
    b,
    { id: "n3", kind: "note", look: "note", md: "# From heading", title: "Chosen by me" } as NoteCard,
    800,
    80,
    300,
  );
  const h = await open({ board: b, light, w: 1200, h: 600 });
  await idle(h);
  const title = (id: string) => h.page.locator(`.card[data-id="${id}"] .chead .ctitle`).textContent();
  const t0 = { n1: await title("n1"), n2: await title("n2"), n3: await title("n3") };
  await shot(h, "note-title-01");
  check("note-title-from-heading", t0.n1 === "KV cache budget" && t0.n2 === "Note" && t0.n3 === "Chosen by me", t0);
  // editing the heading changes the title
  await h.page.locator('.card[data-id="n2"] .nbody').dblclick();
  await h.page.locator(".md-pm:focus").waitFor();
  await h.page.keyboard.press("ControlOrMeta+a");
  await h.page.keyboard.type("# Decode loop\n\nOne token per step.");
  await h.page.keyboard.press("Escape");
  await idle(h);
  const t1 = await title("n2");
  await shot(h, "note-title-02-edited");
  check("note-title-follows-edit", t1 === "Decode loop", {
    t1,
    md: (h.board().cards.find((c) => c.id === "n2") as NoteCard).md,
  });
  await close(h);
});

/** ⌘X cuts the selected cards (one undo step brings them back); ⌘V on the same board puts them back as they were; ⌘X while editing a Note cuts text only */
test("cutCardsPasteUndo", async () => {
  const b = twoSections();
  const code = b.cards[0].id;
  const h = await open({ board: b, light });
  await h.page.keyboard.press("Shift+!");
  await idle(h);
  const p0 = { ...h.board().place.n1 };
  await h.page.locator('.card[data-id="n1"] .chead').click();
  await h.page.locator('.card.sel[data-id="n1"]').waitFor();
  await h.page.keyboard.press("ControlOrMeta+x");
  await idle(h);
  const cut = { n1: !!h.board().cards.find((c) => c.id === "n1"), copied: h.sent.some((m) => m.type === "copyCards") };
  await h.page.keyboard.press("ControlOrMeta+z");
  await until(h, "undo brings the cut card back", () => h.board().cards.some((c) => c.id === "n1"));
  await idle(h);
  const undone = { n1: !!h.board().cards.find((c) => c.id === "n1"), place: h.board().place.n1 };
  await h.page.keyboard.press("ControlOrMeta+Shift+z");
  await idle(h);
  const redone = !h.board().cards.some((c) => c.id === "n1");
  check("cut-removes-card", !cut.n1 && cut.copied, cut);
  check(
    "cut-single-undo",
    undone.n1 && undone.place?.x === p0.x && undone.place?.y === p0.y && undone.place?.section === "S2",
    { undone, p0 },
  );
  check("cut-redo", redone);
  // paste: the clipboard has the card's text; the same card comes back (same id, its heading intact) at the pointer
  await h.page.mouse.move(1000, 700);
  await h.page.evaluate(
    (t) => {
      const dt = new DataTransfer();
      dt.setData("text/plain", t);
      document.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true }));
    },
    (b.cards[1] as NoteCard).md,
  );
  await idle(h);
  const back = h.board().cards.find((c) => c.id === "n1") as NoteCard | undefined;
  await shot(h, "cut-01-pasted");
  check("cut-paste-restores", !!back && back.md === (b.cards[1] as NoteCard).md && h.board().cards.length === 2, {
    ids: h.board().cards.map((c) => c.id),
  });
  // ⌘X inside the Note editor: text is cut, the card stays
  await h.page.locator('.card[data-id="n1"] .nbody').dblclick();
  await h.page.locator(".md-pm:focus").waitFor();
  await h.page.keyboard.press("ControlOrMeta+a");
  await h.page.keyboard.press("ControlOrMeta+x");
  await idle(h);
  await h.page.keyboard.press("Escape");
  await idle(h);
  const ids = h.board().cards.map((c) => c.id);
  check("cut-in-editor-keeps-card", ids.includes(code) && h.sent.filter((m) => m.type === "copyCards").length === 1, {
    ids,
    copies: h.sent.filter((m) => m.type === "copyCards").length,
  });
  await close(h);
});

/** A click on a Section's empty area selects it (the innermost one); a drag there is still a marquee, and a click outside clears */
test("sectionClickEmptySelects", async () => {
  const b = twoSections();
  b.sections.push({ id: "S3", title: "Inner", x: 760, y: 300, w: 320, h: 160, parent: "S2" });
  b.cam = { x: 0, y: 0, z: 1 };
  const h = await open({ board: b, light, w: 1400 });
  await idle(h);
  const pg = h.page;
  const selected = () =>
    pg.evaluate(() => [...document.querySelectorAll(".sect.sel")].map((e) => (e as HTMLElement).dataset.sect));
  const box = async (id: string) => (await pg.locator(`.sect[data-sect="${id}"]`).boundingBox())!;
  const s1 = await box("S1"),
    s3 = await box("S3");
  // S1 的下半截是空的（代码卡在上面）
  await pg.mouse.click(s1.x + 40, s1.y + s1.height - 30);
  await idle(h);
  const one = await selected();
  // ⇧ 点另一个 Section 的空白处：加进选择；再 ⇧ 点一次：移出
  const s2 = await box("S2");
  await pg.keyboard.down("Shift");
  await pg.mouse.click(s2.x + s2.width - 30, s2.y + 30);
  await idle(h);
  const added = await selected();
  // somewhere else in it (the same spot again would be a double-click)
  await pg.mouse.click(s2.x + s2.width - 30, s2.y + s2.height - 30);
  await idle(h);
  const removed = await selected();
  await pg.keyboard.up("Shift");
  await pg.mouse.click(s3.x + s3.width - 30, s3.y + s3.height - 20);
  await idle(h);
  const inner = await selected();
  await pg.mouse.click(s1.x + s1.width + 40, s1.y + s1.height - 30);
  await idle(h);
  const none = await selected();
  // 在 S2 里拖一个框把 Note 框住：选中的是卡，不是 Section
  const n1 = (await pg.locator('.card[data-id="n1"]').boundingBox())!;
  await pg.mouse.move(n1.x - 20, n1.y - 20);
  await pg.mouse.down();
  await pg.mouse.move(n1.x + n1.width / 2, n1.y + n1.height / 2, { steps: 5 });
  await pg.mouse.up();
  await idle(h);
  const dragged = {
    sections: await selected(),
    cards: await pg.evaluate(() =>
      [...document.querySelectorAll(".card.sel")].map((e) => (e as HTMLElement).dataset.id),
    ),
  };
  check(
    "sectionClickEmptySelects",
    one.join() === "S1" &&
      added.sort().join() === "S1,S2" &&
      removed.join() === "S1" &&
      inner.join() === "S3" &&
      none.length === 0 &&
      dragged.sections.length === 0 &&
      dragged.cards.join() === "n1",
    { one, added, removed, inner, none, dragged },
  );
  await close(h);
});

/** A selected Section moves when its empty area is dragged, with its cards; an unselected one is not moved by that drag */
test("sectionCmdDragEmptyMoves", async () => {
  const b = twoSections();
  b.cam = { x: 0, y: 0, z: 1 };
  const h = await open({ board: b, light, w: 1400 });
  await idle(h);
  const pg = h.page;
  const s1 = (await pg.locator('.sect[data-sect="S1"]').boundingBox())!;
  const code = b.cards[0].id;
  const at = () => {
    const q = h.board();
    const s = q.sections.find((x) => x.id === "S1")!;
    return { sx: s.x, sy: s.y, cx: q.place[code].x, cy: q.place[code].y };
  };
  const drag = async (x: number, y: number) => {
    await pg.mouse.move(x, y);
    await pg.mouse.down();
    await pg.mouse.move(x + 60, y + 40, { steps: 6 });
    await pg.mouse.up();
    await idle(h);
  };
  const p0 = at();
  // 不按 ⌘：没选中、选中了，拖空白处都是框选，Section 不动
  await drag(s1.x + 40, s1.y + s1.height - 120);
  await pg.mouse.click(s1.x + s1.width + 40, s1.y + 20);
  await idle(h);
  await pg.mouse.click(s1.x + 40, s1.y + s1.height - 30);
  await idle(h);
  await drag(s1.x + 200, s1.y + s1.height - 60);
  const p1 = at();
  // 按着 ⌘ 拖空白处：Section 和里面的卡一起走（⌘ 也关掉吸附，挪多少就是多少）
  await pg.mouse.click(s1.x + s1.width + 40, s1.y + 20);
  await idle(h);
  await pg.keyboard.down("Meta");
  await drag(s1.x + 120, s1.y + s1.height - 90);
  await pg.keyboard.up("Meta");
  await until(h, "the Section move is saved", () => at().sx !== p0.sx);
  const p2 = at();
  check(
    "sectionCmdDragEmptyMoves",
    p1.sx === p0.sx &&
      p1.sy === p0.sy &&
      p2.sx - p0.sx === 60 &&
      p2.sy - p0.sy === 40 &&
      p2.cx - p0.cx === 60 &&
      p2.cy - p0.cy === 40,
    { p0, p1, p2 },
  );
  await close(h);
});

/** twoSections and a Note on its own to their right (in no Section), the camera at the origin */
function twoSectionsAndLoose(): Board {
  const b = twoSections();
  put(b, { id: "n2", kind: "note", look: "note", md: "# Loose\n\nIn no Section." } as NoteCard, 1320, 110, 240);
  b.cam = { x: 0, y: 0, z: 1 };
  return b;
}
const selSections = (h: Host) =>
  h.page.evaluate(() =>
    [...document.querySelectorAll(".sect.sel")].map((e) => (e as HTMLElement).dataset.sect ?? "").sort(),
  );
const selCards = (h: Host) =>
  h.page.evaluate(() =>
    [...document.querySelectorAll(".card.sel")].map((e) => (e as HTMLElement).dataset.id ?? "").sort(),
  );
const title = (h: Host, id: string) => h.page.locator(`.slabel[data-sect="${id}"] .sname`);

/** ⌘-click (and ⇧-click) on a Section's title adds it to the selection or takes it out, cards kept; the Section menu with several
 *  selected colours them all in one undo step */
test("sectionMultiSelectColor", async () => {
  const h = await open({ board: twoSectionsAndLoose(), light, w: 1600 });
  await idle(h);
  await title(h, "S1").click();
  await title(h, "S2").click({ modifiers: ["Meta"] });
  await idle(h);
  const both = await selSections(h);
  await title(h, "S2").click({ button: "right" });
  await h.page.locator(".ctx:not(.closing) button", { hasText: "Color" }).hover();
  await h.page.locator(".ctx:not(.closing) button", { hasText: "Light Green" }).click();
  await until(h, "both Sections are coloured", () => h.board().sections.every((s) => s.color === "green"));
  await shot(h, "sect-multi-01-coloured");
  await h.page.keyboard.press("Meta+z");
  await until(h, "the colour is undone", () => h.board().sections.every((s) => !s.color));
  // 卡和 Section 在同一个选择里：⌘ 点标题拿掉一个 Section，卡留着；⇧ 点再加回来
  await h.page.locator('.card[data-id="n2"]').click({ modifiers: ["Shift"] });
  await title(h, "S1").click({ modifiers: ["Meta"] });
  await idle(h);
  const less = { sections: await selSections(h), cards: await selCards(h) };
  await title(h, "S1").click({ modifiers: ["Shift"] });
  await idle(h);
  const again = { sections: await selSections(h), cards: await selCards(h) };
  check(
    "sectionMultiSelectColor",
    both.join() === "S1,S2" &&
      less.sections.join() === "S2" &&
      less.cards.join() === "n2" &&
      again.sections.join() === "S1,S2" &&
      again.cards.join() === "n2",
    { both, less, again },
  );
  await close(h);
});

/** Tidy Up on several Sections lays them out as blocks: each frame moves with its cards (same place inside it), the frames do
 *  not overlap afterwards, and one undo puts everything back */
test("sectionTidyUp", async () => {
  const b = twoSectionsAndLoose();
  // S2 on top of S1's lower half, so Tidy Up has something to do
  b.sections[1].x = 300;
  b.sections[1].y = 500;
  b.place.n1.x = 340;
  b.place.n1.y = 550;
  // an unselected Note where S2 would go: Tidy Up keeps clear of it
  put(b, { id: "n3", kind: "note", look: "note", md: "# Beside\n\nNot selected." } as NoteCard, 720, 100, 260);
  const h = await open({ board: b, light, w: 1600, h: 1000 });
  await idle(h);
  const inside = (bd: Board) => {
    const S2 = bd.sections.find((s) => s.id === "S2")!;
    return [bd.place.n1.x - S2.x, bd.place.n1.y - S2.y];
  };
  const before = JSON.stringify({ s: h.board().sections, p: h.board().place });
  const off0 = inside(h.board());
  await shot(h, "sect-tidy-00-before");
  await title(h, "S1").click();
  await title(h, "S2").click({ modifiers: ["Shift"] });
  await title(h, "S2").click({ button: "right" });
  await h.page.locator(".ctx:not(.closing) button", { hasText: "Tidy Up" }).click();
  await until(
    h,
    "the Sections are moved",
    () => JSON.stringify({ s: h.board().sections, p: h.board().place }) !== before,
  );
  await idle(h);
  await shot(h, "sect-tidy-01-after");
  const frames = await h.page.evaluate(() =>
    ['.sect[data-sect="S1"]', '.sect[data-sect="S2"]', '.card[data-id="n3"]'].map((q) =>
      document.querySelector(q)!.getBoundingClientRect(),
    ),
  );
  const clear = (a: DOMRect, c: DOMRect) =>
    a.right <= c.left || c.right <= a.left || a.bottom <= c.top || c.bottom <= a.top;
  const apart = clear(frames[0], frames[1]) && clear(frames[0], frames[2]) && clear(frames[1], frames[2]);
  const off1 = inside(h.board());
  const loose = h.board().place.n2;
  await h.page.keyboard.press("ControlOrMeta+z");
  await until(
    h,
    "one undo puts it back",
    () => JSON.stringify({ s: h.board().sections, p: h.board().place }) === before,
  );
  check(
    "sectionTidyUp the Sections are laid out apart and clear of the unselected Note, each with its cards, the loose card stays",
    apart && off0.join() === off1.join() && loose.x === 1320 && loose.y === 110,
    { frames, off0, off1, loose },
  );
  await close(h);
});

/** A marquee selects the Sections whose whole frame it encloses (one it only crosses is not), with the cards it touches; ⇧ adds */
test("sectionMarqueeSelects", async () => {
  const h = await open({ board: twoSectionsAndLoose(), light, w: 1600 });
  await idle(h);
  const pg = h.page;
  const box = async (id: string) => (await pg.locator(`.sect[data-sect="${id}"]`).boundingBox())!;
  const marquee = async (x0: number, y0: number, x1: number, y1: number, shift = false) => {
    if (shift) await pg.keyboard.down("Shift");
    await pg.mouse.move(x0, y0);
    await pg.mouse.down();
    await pg.mouse.move(x1, y1, { steps: 6 });
    await pg.mouse.up();
    if (shift) await pg.keyboard.up("Shift");
    await idle(h);
  };
  const s1 = await box("S1"),
    s2 = await box("S2");
  // 框住整个 S2，只碰到 S1 的右边一截
  await marquee(s1.x + s1.width - 20, s2.y - 30, s2.x + s2.width + 20, s2.y + s2.height + 20);
  const one = { sections: await selSections(h), cards: await selCards(h) };
  await marquee(s1.x - 20, s1.y - 30, s1.x + s1.width + 20, s1.y + s1.height + 20, true);
  const added = await selSections(h);
  check(
    "sectionMarqueeSelects",
    one.sections.join() === "S2" && one.cards.join() === "n1" && added.join() === "S1,S2",
    {
      one,
      added,
    },
  );
  await close(h);
});

/** Several selected Sections and a card on its own are dragged together by one Section's title, each with its cards, and one undo
 *  brings everything back */
test("sectionGroupDrag", async () => {
  const b = twoSectionsAndLoose();
  const h = await open({ board: b, light, w: 1600 });
  await idle(h);
  const pg = h.page;
  const code = b.cards[0].id;
  const at = () => {
    const q = h.board();
    const s = (id: string) => q.sections.find((x) => x.id === id)!;
    return {
      s1: [s("S1").x, s("S1").y],
      s2: [s("S2").x, s("S2").y],
      code: [q.place[code].x, q.place[code].y],
      n1: [q.place.n1.x, q.place.n1.y],
      n2: [q.place.n2.x, q.place.n2.y],
      homes: [q.place[code].section, q.place.n1.section, q.place.n2.section ?? "-"].join(),
      parents: q.sections.map((x) => x.parent ?? "-").join(),
    };
  };
  await title(h, "S1").click({ modifiers: ["Shift"] });
  await title(h, "S2").click({ modifiers: ["Shift"] });
  await pg.locator('.card[data-id="n2"]').click({ modifiers: ["Shift"] });
  await idle(h);
  const p0 = at();
  const t = (await title(h, "S1").boundingBox())!;
  await pg.mouse.move(t.x + 10, t.y + t.height / 2);
  await pg.mouse.down();
  // ⌘ 关掉吸附：挪多少就是多少
  await pg.keyboard.down("Meta");
  await pg.mouse.move(t.x + 40, t.y + t.height / 2 + 20, { steps: 4 });
  await shot(h, "sect-group-01-mid-drag", "now");
  await pg.mouse.move(t.x + 70, t.y + t.height / 2 + 40, { steps: 4 });
  await pg.mouse.up();
  await pg.keyboard.up("Meta");
  await until(h, "the group move is saved", () => at().n2[0] !== p0.n2[0]);
  const p1 = at();
  await pg.keyboard.press("Meta+z");
  await until(h, "the group move is undone", () => at().n2[0] === p0.n2[0]);
  const p2 = at();
  const keys = ["s1", "s2", "code", "n1", "n2"] as const;
  const moved = keys.map((k) => [p1[k][0] - p0[k][0], p1[k][1] - p0[k][1]].join());
  check(
    "sectionGroupDrag",
    moved.every((m) => m === "60,40") &&
      p1.homes === p0.homes &&
      p1.parents === p0.parents &&
      JSON.stringify(p2) === JSON.stringify(p0),
    { p0, p1, p2, moved },
  );
  await close(h);
});

/** ⌫ with several Sections selected removes them all (their cards stay), and one undo brings them all back */
test("sectionGroupDeleteUndo", async () => {
  const h = await open({ board: twoSectionsAndLoose(), light, w: 1600 });
  await idle(h);
  await title(h, "S1").click();
  await title(h, "S2").click({ modifiers: ["Meta"] });
  await idle(h);
  await h.page.keyboard.press("Backspace");
  await until(h, "the Sections are removed", () => h.board().sections.length < 2);
  await idle(h);
  const gone = { sections: h.board().sections.length, cards: h.board().cards.length };
  await h.page.keyboard.press("Meta+z");
  await until(h, "the Sections are back", () => h.board().sections.length === 2);
  const back = h
    .board()
    .sections.map((s) => s.id)
    .join();
  check("sectionGroupDeleteUndo", gone.sections === 0 && gone.cards === 3 && back === "S1,S2", { gone, back });
  await close(h);
});

/** Resizing a Section changes who is in it: dragged out over a loose card, the card joins (the Section lights up while it is
 *  dragged); dragged in past a card of its own, that card leaves; each drag one undo step, frame and members together. A locked
 *  card stays where it is */
test("sectionResizeMembers", async () => {
  const b = twoSectionsAndLoose();
  put(b, { id: "n3", kind: "note", look: "note", md: "# Locked\n\nStays out." } as NoteCard, 1320, 300, 240);
  b.place.n3.locked = true;
  const h = await open({ board: b, light, w: 1600 });
  await idle(h);
  const pg = h.page;
  const home = (id: string) => h.board().place[id].section;
  const box = async (sel: string) => (await pg.locator(sel).boundingBox())!;
  const drag = async (edge: string, toX: number, mid?: string) => {
    const r = await box(`.sect[data-sect="S2"] .sedge[data-edge="${edge}"]`);
    const x = r.x + r.width / 2,
      y = r.y + r.height / 2;
    await pg.mouse.move(x, y);
    await pg.mouse.down();
    await pg.mouse.move(toX, y, { steps: 6 });
    const lit = await pg.locator('.sect[data-sect="S2"].drop').count();
    if (mid) await shot(h, mid, "now");
    await pg.mouse.up();
    await idle(h);
    return lit;
  };
  const n2 = await box('.card[data-id="n2"]');
  const litJoin = await drag("e", n2.x + n2.width + 30, "sect-members-01-growing-over-loose-card");
  const joined = home("n2"),
    locked = home("n3");
  const grown = await box('.sect[data-sect="S2"]');
  await shot(h, "sect-members-02-loose-card-joined");
  const n1 = await box('.card[data-id="n1"]');
  await drag("w", n1.x + n1.width + 30);
  const left = { n1: home("n1"), n2: home("n2") };
  const shrunk = await box('.sect[data-sect="S2"]');
  await shot(h, "sect-members-03-card-left");
  await pg.keyboard.press("Meta+z");
  await idle(h);
  const undo1 = { n1: home("n1"), n2: home("n2"), x: h.board().sections.find((s) => s.id === "S2")!.x };
  await pg.keyboard.press("Meta+z");
  await idle(h);
  const undo2 = { n1: home("n1"), n2: home("n2") };
  check(
    "sectionResizeMembers",
    litJoin === 1 &&
      joined === "S2" &&
      locked === undefined &&
      grown.x + grown.width >= n2.x + n2.width &&
      left.n1 === undefined &&
      left.n2 === "S2" &&
      shrunk.x > n1.x + n1.width &&
      undo1.n1 === "S2" &&
      undo1.n2 === "S2" &&
      undo1.x === 720 &&
      undo2.n1 === "S2" &&
      undo2.n2 === undefined,
    { litJoin, joined, locked, grown, n2, left, shrunk, undo1, undo2 },
  );
  await close(h);
});

/** A Section is resized by any of its four edges and four corners, the opposite edges staying put, one undo step each; shrunk
 *  part way past a card (it still covers a third of it), the frame stops around it and the card stays in the Section */
test("sectionResizeEdges", async () => {
  const h = await open({ board: twoSectionsAndLoose(), light, w: 1600 });
  await idle(h);
  const pg = h.page;
  const handles = await pg.locator('.sect[data-sect="S2"] .sedge').count();
  check("sectionResizeEdges has a handle on each side and corner", handles === 8, { handles });
  if (handles !== 8) return close(h);
  const frame = async (id: string) => {
    const r = (await pg.locator(`.sect[data-sect="${id}"]`).boundingBox())!;
    return { l: Math.round(r.x), t: Math.round(r.y), r: Math.round(r.x + r.width), b: Math.round(r.y + r.height) };
  };
  const drag = async (id: string, edge: string, dx: number, dy: number, mid?: string) => {
    const r = (await pg.locator(`.sect[data-sect="${id}"] .sedge[data-edge="${edge}"]`).boundingBox())!;
    const x = r.x + r.width / 2,
      y = r.y + r.height / 2;
    await pg.mouse.move(x, y);
    await pg.mouse.down();
    await pg.mouse.move(x + dx / 2, y + dy / 2, { steps: 4 });
    if (mid) await shot(h, mid, "now");
    await pg.mouse.move(x + dx, y + dy, { steps: 4 });
    await pg.mouse.up();
    await idle(h);
  };
  const diff = (a: Record<string, number>, b: Record<string, number>) =>
    ["l", "t", "r", "b"].map((k) => b[k] - a[k]).join();
  const s2 = await frame("S2"),
    s1 = await frame("S1");
  await drag("S2", "w", -60, 15, "sect-resize-01-left-edge-mid-drag");
  const left = diff(s2, await frame("S2"));
  await pg.keyboard.press("Meta+z");
  await idle(h);
  const undone = diff(s2, await frame("S2"));
  await drag("S1", "n", 10, -30);
  const top = diff(s1, await frame("S1"));
  await drag("S2", "e", 40, 10);
  const right = diff(s2, await frame("S2"));
  await drag("S2", "sw", -20, 30);
  const corner = diff(s2, await frame("S2"));
  // 左边往右拖进 Note 一截（Note 还有三分之一多在框里）：框停在 Note 外面，Note 还在 S2 里
  const n1 = (await pg.locator('.card[data-id="n1"]').boundingBox())!;
  await drag("S2", "w", n1.x + 200 - s2.l, 0);
  const past = await frame("S2");
  const stillIn = h.board().place.n1.section;
  check(
    "sectionResizeEdges",
    left === "-60,0,0,0" &&
      undone === "0,0,0,0" &&
      top === "0,-30,0,0" &&
      right === "0,0,40,0" &&
      corner === "-20,0,40,30" &&
      past.l < n1.x &&
      past.l >= s2.l &&
      h.board().sections.find((s) => s.id === "S2")!.x > h.board().place.n1.x &&
      stillIn === "S2",
    { left, undone, top, right, corner, past, n1: n1.x, stillIn },
  );
  await close(h);
});

/** A wheel (two-finger) pan pans the board the same over a Section as over the empty canvas: on its edges and corners (the
 *  resize handles), on its title and on the title's caret. Each is a new gesture, so none rides on a pan already going */
test("sectionEdgeWheelPans", async () => {
  const b = twoSectionsAndLoose();
  b.cam = { x: 0, y: 160, z: 1 }; // room above the titles for the pans
  const h = await open({ board: b, light, w: 1600, h: 900 });
  await idle(h);
  const pg = h.page;
  const camOf = () =>
    pg.evaluate(() => {
      const m = /translate\(([-\d.]+)px, ([-\d.]+)px\)/.exec(
        (document.querySelector(".world") as HTMLElement).style.transform,
      );
      return { x: Number(m![1]), y: Number(m![2]) };
    });
  const centre = async (sel: string) => {
    const r = (await pg.locator(sel).boundingBox())!;
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  };
  const S2 = '[data-sect="S2"]';
  const below = async () => {
    const r = (await pg.locator(`.sect${S2}`).boundingBox())!;
    return { x: r.x + r.width / 2, y: r.y + r.height + 120 };
  };
  // where the pointer is, and what the hit test there must find (so the wheel goes to that element)
  const targets: [string, string, () => Promise<{ x: number; y: number }>][] = [
    ["canvas", "#board > .world, #board", below],
    ...["e", "s", "se"].map((k): [string, string, () => Promise<{ x: number; y: number }>] => {
      const sel = `.sect${S2} .sedge[data-edge="${k}"]`;
      return [`edge ${k}`, sel, () => centre(sel)];
    }),
    ["title", `.slabel${S2} .sname`, () => centre(`.slabel${S2} .sname`)],
    ["caret", `.slabel${S2} .chev2`, () => centre(`.slabel${S2} .chev2`)],
  ];
  const runs: { where: string; under: string; moved: string; want: string }[] = [];
  let sign = 1;
  for (const [where, sel, at] of targets) {
    const p = await at();
    await pg.mouse.move(p.x, p.y);
    await idle(h);
    await hold(h, WHEEL_GESTURE + 100, "a new wheel gesture: longer than the gap that ends one");
    const under = await pg.evaluate(
      ([x, y, s]) => {
        const e = document.elementFromPoint(x, y);
        if (!e) return "nothing";
        return s.startsWith("#board") ? (e.matches(s) ? "" : e.className) : e.closest(s) ? "" : e.className;
      },
      [p.x, p.y, sel] as const,
    );
    const c0 = await camOf();
    await pg.mouse.wheel(30 * sign, 40 * sign);
    await idle(h);
    const c1 = await camOf();
    runs.push({
      where,
      under,
      moved: `${Math.round(c1.x - c0.x)},${Math.round(c1.y - c0.y)}`,
      want: `${-30 * sign},${-40 * sign}`,
    });
    sign = -sign;
  }
  check(
    "sectionEdgeWheelPans",
    runs.every((r) => r.under === "" && r.moved === r.want),
    runs,
  );
  await close(h);
});

/**
 * Folding a Section and opening it again, watched frame by frame (watch.ts): its cards and arrows move into the folded frame
 * and back without a jump, the card outside it stays put, nothing flashes and no title shows twice over itself
 */
test("sectionFoldWatched", async () => {
  const b = emptyBoard("b1", "fold watched");
  for (let i = 0; i < 4; i++) {
    put(
      b,
      { id: `n${i}`, kind: "note", look: "note", md: `# N${i}\n\nwords ${i}` } as NoteCard,
      120 + (i % 2) * 300,
      140 + Math.floor(i / 2) * 160,
      260,
    );
    b.place[`n${i}`].section = "S";
  }
  put(b, { id: "out", kind: "note", look: "note", md: "# Out\n\nnot in it" } as NoteCard, 900, 140, 260);
  b.sections.push({ id: "S", title: "Fold me", x: 80, y: 80, w: 700, h: 500 });
  b.links.push({ id: "L1", from: { card: "n0" }, to: { card: "out" } } as never);
  b.cam = { x: 0, y: 0, z: 1 };
  const h = await open({ board: b, light, w: 1300, h: 760 });
  await idle(h);
  const label = '.slabel[data-sect="S"]';
  await h.page.locator(label).hover();
  await idle(h);
  const o = { moves: [/^card:n/, /^sect:/, /^link:/, /^el:/], follow: [label], keep: [label], frames: 50 };
  await watch(h, "sectionFoldWatched fold", o, () => h.page.locator(`${label} .chev2`).click());
  await idle(h);
  check("sectionFoldWatched the Section is folded", h.board().sections[0].collapsed === true, h.board().sections[0]);
  await watch(h, "sectionFoldWatched open", o, () => h.page.locator(`${label} .chev2`).click());
  await idle(h);
  check("sectionFoldWatched the Section is open again", !h.board().sections[0].collapsed, h.board().sections[0]);
});
