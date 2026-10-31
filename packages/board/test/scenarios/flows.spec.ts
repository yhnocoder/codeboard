import { shot, symCard, findSym, viewOf, put, type Host } from "../harness";
import { emptyBoard, putShared, type Board } from "@codeboard/core";
import { RESEND_DELAY } from "../../src/state/timing";
import { test, open, check, light, expect, until, idle } from "../fixtures";

function boardWith(...quals: string[]): Board {
  const b = emptyBoard("b1", "nano-vllm · generate main flow");
  let x = 80;
  for (const q of quals) {
    const s = findSym(q);
    const c = symCard(s.f, s.s);
    put(b, c, x, 80);
    x += 640;
  }
  return b;
}
/** The symbol a code card shows (its first segment), e.g. "Scheduler.schedule"; the kind of any other card */
const qualOf = (b: Board, id: string) => {
  const c = b.cards.find((x) => x.id === id);
  return c?.kind === "code" ? c.segments[0].symbol?.qual : c?.kind;
};
/** The board's call arrows as [call, from card, to card], sorted */
const callArrows = (b: Board) =>
  b.links
    .filter((l) => l.call)
    .map((l) => [l.call!.name, qualOf(b, l.from.card), qualOf(b, l.to.card)])
    .sort((x, y) => String(x).localeCompare(String(y)));
const callEl = (h: Host, name: string, nth = 0) => h.page.locator(`.card .src .call:text-is("${name}")`).nth(nth);
/** Something took the keyboard to type into (a section's name, a new Text, the palette): an input, a textarea or an editor */
const typingInto = (h: Host) =>
  h.page.waitForFunction(
    () => {
      const a = document.activeElement as HTMLElement | null;
      return !!a && (a.matches("input, textarea") || a.isContentEditable);
    },
    null,
    { timeout: 5000 },
  );

test("expandCall", async () => {
  const h = await open({ board: boardWith("LLMEngine.step"), light });
  await shot(h, "01-start");
  await callEl(h, "schedule").click();
  await until(h, "schedule() expands into a card", () => h.board().cards.length > 1);
  await shot(h, "02-expanded");
  await callEl(h, "postprocess").click();
  await until(h, "postprocess() expands into a card", () => h.board().cards.length > 2);
  await shot(h, "03-two");
  const nb = h.board();
  const arrows = callArrows(nb);
  check(
    "expandCall the clicked calls open their callees, each with its call arrow",
    nb.cards.length === 3 &&
      JSON.stringify(arrows) ===
        JSON.stringify([
          ["postprocess", "LLMEngine.step", "Scheduler.postprocess"],
          ["schedule", "LLMEngine.step", "Scheduler.schedule"],
        ]),
    { cards: nb.cards.map((c) => qualOf(nb, c.id)), arrows },
  );
  const drawn = { cards: await h.page.locator(".card").count(), arrows: await h.page.locator("path.lhit").count() };
  check("expandCall the new cards and arrows are drawn", drawn.cards === 3 && drawn.arrows === 2, drawn);
  await h.page.context().close();
});

test("expandAndWalk", async () => {
  const h = await open({ board: boardWith("LLMEngine.step"), light });
  await callEl(h, "schedule").click();
  await until(h, "schedule() expands", () => h.board().cards.length > 1);
  await shot(h, "flow-00");
  await callEl(h, "postprocess").first().click({ timeout: 5000 });
  await until(h, "postprocess() expands", () => h.board().cards.length > 2);
  const pos = () =>
    JSON.stringify(
      h
        .board()
        .cards.map((c: any) => [c.segments?.[0]?.symbol?.qual, h.board().place[c.id]?.x, h.board().place[c.id]?.y]),
    );
  await idle(h);
  console.log(pos());
  await h.page
    .locator(".card .src .call", { hasText: /^allocate$/ })
    .first()
    .click();
  await until(h, "allocate() expands", () => h.board().cards.length > 3);
  await idle(h);
  console.log(pos());
  const arrows = callArrows(h.board());
  check(
    "expandAndWalk a call in an expanded card expands one level further",
    JSON.stringify(arrows) ===
      JSON.stringify([
        ["allocate", "Scheduler.schedule", "BlockManager.allocate"],
        ["postprocess", "LLMEngine.step", "Scheduler.postprocess"],
        ["schedule", "LLMEngine.step", "Scheduler.schedule"],
      ]),
    { arrows },
  );
  await h.page.keyboard.press("Shift+!");
  await idle(h);
  await shot(h, "flow-01-three");
  await h.page.keyboard.press("Escape");
  const bar = h.page.locator(".present.on");
  const at = async () => ({
    n: await bar.locator(".cnt").textContent(),
    title: await bar.locator(".ptitle").textContent(),
  });
  await h.page.keyboard.press("p");
  await bar.waitFor();
  await idle(h);
  const w1 = await at();
  await shot(h, "flow-02-walk");
  await h.page.keyboard.press("ArrowRight");
  await expect(bar.locator(".cnt")).not.toHaveText(w1.n!);
  await idle(h);
  const w2 = await at();
  await shot(h, "flow-03-walk2");
  await h.page.keyboard.press("Escape");
  await expect(bar).toHaveCount(0);
  check(
    "expandAndWalk the walkthrough starts at the entry card and → goes to the next of its 4 steps",
    w1.n === "1 / 4" && /step/.test(w1.title ?? "") && w2.n === "2 / 4" && w2.title !== w1.title,
    { w1, w2 },
  );
  await h.page.context().close();
});

test("notes", async () => {
  const h = await open({ board: boardWith("Scheduler.schedule"), light });
  const lines = [
    Number(await h.page.locator(".card .no").nth(5).textContent()),
    Number(await h.page.locator(".card .no").nth(7).textContent()),
  ];
  await h.page.locator(".card .no").nth(5).click();
  await h.page
    .locator(".card .no")
    .nth(7)
    .click({ modifiers: ["Shift"] });
  await shot(h, "notes-01-lines");
  await h.page.keyboard.press("s");
  await h.page.locator(".pop button", { hasText: /^Text$/ }).waitFor();
  await shot(h, "notes-02-add");
  await h.page.locator(".pop button", { hasText: /^Text$/ }).click();
  await h.page.locator(".pop textarea, .pop [contenteditable]").first().click();
  await h.page.keyboard.type("Prefill admits waiting seqs until the token budget runs out.");
  await h.page.locator(".pop button", { hasText: /^Add$/ }).click();
  await until(h, "the sidenote is added", () => h.board().sidenotes.length);
  const sn = h.board().sidenotes as any[];
  check(
    "notes the Sidenote holds the typed text, on the selected lines",
    sn.length === 1 &&
      sn[0].kind === "text" &&
      sn[0].md === "Prefill admits waiting seqs until the token budget runs out." &&
      sn[0].at.card === h.board().cards[0].id &&
      JSON.stringify(sn[0].at.lines) === JSON.stringify(lines),
    { sn, lines },
  );
  await shot(h, "notes-03-done");
  await h.page.mouse.move(1300, 800);
  await h.page.keyboard.press("n");
  await h.page.locator(".md-pm:focus").waitFor();
  await h.page.keyboard.type("# Why chunked prefill\nKeeps $O(n)$ memory **bounded**.");
  await h.page.keyboard.press("Escape");
  await until(h, "the Note is saved", () => h.board().cards.some((c) => c.kind === "note"));
  await idle(h);
  await h.page.mouse.click(1300, 500);
  await shot(h, "notes-04-note");
  const note = h.board().cards.find((c) => c.kind === "note") as any;
  const shown = await h.page.locator(`.card[data-id="${note?.id}"]`).evaluate((e) => ({
    h1: e.querySelector("h1")?.textContent,
    math: !!e.querySelector(".katex"),
    bold: e.querySelector("strong")?.textContent,
  }));
  check(
    "notes the Note keeps the typed Markdown and shows it rendered",
    /^# Why chunked prefill\n+Keeps \$O\(n\)\$ memory \*\*bounded\*\*\.$/.test(note?.md ?? "") &&
      shown.h1 === "Why chunked prefill" &&
      shown.math &&
      shown.bold === "bounded",
    { md: note?.md, shown },
  );
  await h.page.locator(".card .mk").first().hover();
  await h.page.locator(".pop.k-notes").waitFor(); // shows 120 ms after the hover
  await shot(h, "notes-05-hover");
  const hover = await h.page.locator(".pop.k-notes").textContent();
  check(
    "notes hovering the line mark shows the Sidenote",
    /Prefill admits waiting seqs until the token budget runs out\./.test(hover ?? ""),
    { hover },
  );
  await h.page.context().close();
});

test("sections", async () => {
  const b = boardWith("LLMEngine.step", "Scheduler.schedule");
  const h = await open({ board: b, light });
  await h.page.keyboard.press("Shift+!");
  await idle(h);
  const r = await h.page.locator(".card").first().boundingBox();
  await h.page.locator('.bbar button[aria-label="Section"]').click();
  await h.page.mouse.move(r!.x - 40, r!.y - 60);
  await h.page.mouse.down();
  await h.page.mouse.move(r!.x + r!.width + 30, r!.y + r!.height + 40, { steps: 8 });
  await h.page.mouse.up();
  await typingInto(h);
  await h.page.keyboard.type("Engine");
  await h.page.keyboard.press("Enter");
  await h.page.locator('.bbar button[aria-label="Section"]').click();
  await h.page.mouse.move(r!.x - 80, r!.y - 120);
  await h.page.mouse.down();
  await h.page.mouse.move(1350, 820, { steps: 8 });
  await h.page.mouse.up();
  await typingInto(h);
  await h.page.keyboard.type("Generate step");
  await h.page.keyboard.press("Enter");
  await until(h, "both sections are saved", () => h.board().sections.length > 1);
  await shot(h, "sec-01-nested");
  const nb = h.board(),
    title = (id?: string) => nb.sections.find((q) => q.id === id)?.title ?? null;
  const got = {
    sections: nb.sections.map((q) => [q.title, title(q.parent)]),
    cards: nb.cards.map((c) => title(nb.place[c.id]?.section)),
  };
  // the outer frame, drawn second, takes in the first one and the second card
  check(
    "sections a frame drawn around another one becomes its parent and takes the cards inside",
    JSON.stringify(got) ===
      JSON.stringify({
        sections: [
          ["Engine", "Generate step"],
          ["Generate step", null],
        ],
        cards: ["Engine", "Generate step"],
      }),
    got,
  );
  await h.page.context().close();
});

test("compare", async () => {
  const h = await open({ board: boardWith("Scheduler.schedule", "Scheduler.postprocess"), light });
  await h.page.keyboard.press("Shift+!");
  await idle(h);
  await h.page.keyboard.press("Control+a");
  await h.page.keyboard.press("Meta+a");
  await h.page.locator(".card").first().locator(".chead").click({ button: "right" });
  await h.page.locator(".ctx button").first().waitFor();
  await shot(h, "cmp-01-menu");
  await h.page.locator(".ctx button", { hasText: "Compare" }).first().click();
  await until(h, "Compare makes a compare card", () => h.board().cards.some((c) => c.kind === "compare"));
  await shot(h, "cmp-02-compare");
  console.log(
    "kinds:",
    h
      .board()
      .cards.map((c) => c.kind)
      .join(","),
  );
  // Unified: switching turns it into a single-column diff
  await h.page.locator(".cmpwrap .tools button", { hasText: "Unified" }).click();
  await h.page.locator(".cmpwrap .urow").first().waitFor();
  await idle(h);
  const u = {
    urow: await h.page.locator(".cmpwrap .urow").count(),
    crow: await h.page.locator(".cmpwrap .crow").count(),
  };
  await shot(h, "cmp-03-unified");
  check("compare-unified", u.urow > 0 && u.crow === 0, JSON.stringify(u));
  await h.page.context().close();
});

// The board's word-diff <mark> (Compare) is rounded and filled; a Note's ==highlight== on the same board keeps the Markdown
// package's flat lower band (the package's stylesheet does not override board rules)
test("compareWordDiffMark", async () => {
  const b = emptyBoard("b1", "marks");
  const cl = symCard(findSym("BlockManager.can_allocate").f, findSym("BlockManager.can_allocate").s);
  const cr = symCard(findSym("BlockManager.allocate").f, findSym("BlockManager.allocate").s);
  b.cards.push(cl, cr, { id: "k", kind: "compare", cols: [cl.id, cr.id] });
  b.place.k = { x: 80, y: 80, w: 900 };
  put(b, { id: "n1", kind: "note", md: "Some ==highlighted words== here", look: "note" } as any, 80, 700, 400);
  const h = await open({ board: b, light });
  await h.page.keyboard.press("Shift+!");
  await idle(h);
  await h.page.locator(".card.cmp mark").first().waitFor();
  await h.page.locator('.card[data-id="n1"] .nbody mark').waitFor();
  const look = (q: string) =>
    h.page.evaluate(
      (q) =>
        [...document.querySelectorAll(q)].map((e) => {
          const c = getComputedStyle(e);
          return { radius: c.borderRadius, bg: c.backgroundColor, img: c.backgroundImage };
        }),
      q,
    );
  const diff = await look(".card.cmp mark"),
    note = await look('.card[data-id="n1"] .nbody mark');
  await shot(h, "cmp-wordDiff-and-highlight");
  const r = { diff: diff.slice(0, 3), note };
  check(
    "compareWordDiffMark-diff",
    diff.length > 0 && diff.every((d) => d.radius === "2px" && d.bg !== "rgba(0, 0, 0, 0)" && d.img === "none"),
    r,
  );
  check(
    "compareWordDiffMark-note",
    note.length === 1 &&
      note[0].radius === "0px" &&
      note[0].img.startsWith("linear-gradient") &&
      note[0].bg === "rgba(0, 0, 0, 0)",
    r,
  );
  await h.page.context().close();
});

test("versions", async () => {
  const b = boardWith("Scheduler.schedule");
  const h = await open({ board: b, light });
  const seg = (b.cards[0] as any).segments[0].id;
  await h.post({ type: "stale", stale: { [seg]: { state: "changed", hiddenOnly: false, head: "f64d8210" } } } as any);
  await h.page.locator(".banner").waitFor();
  await shot(h, "ver-01-stale");
  await h.page.locator(".banner button", { hasText: "Review" }).click();
  await h.page
    .locator(".pop button", { hasText: /^Update/ })
    .first()
    .waitFor(); // the diff comes from the host
  await shot(h, "ver-02-diff");
  console.log(
    await h.page.evaluate(() =>
      [...document.querySelectorAll(".pop, .pop .diffpop, .pop .dbody, .pop .crows, .pop .db")]
        .map((e) => {
          const r = e.getBoundingClientRect();
          return e.className + " " + Math.round(r.x) + " " + Math.round(r.width) + " " + getComputedStyle(e).width;
        })
        .join("\n"),
    ),
  );
  const v0 = JSON.stringify((h.board().cards[0] as any).segments[0].version);
  await h.page
    .locator(".pop button", { hasText: /^Update/ })
    .first()
    .click();
  await until(
    h,
    "Update pins the new version",
    () => JSON.stringify((h.board().cards[0] as any).segments[0].version) !== v0,
  );
  await expect(h.page.locator(".banner")).toHaveCount(0);
  await shot(h, "ver-03-updated");
  const sg = (h.board().cards[0] as any).segments[0];
  const shown = await h.page.locator(".card .src .l").nth(3).textContent();
  check(
    "versions Update pins the host's new version, its code shows and the banner goes",
    sg.version.commit === "f64d8210" && sg.text[3].endsWith("  # changed") && /# changed$/.test(shown ?? ""),
    { version: sg.version, line: sg.text[3], shown },
  );
  await h.page.context().close();
});

test("lost", async () => {
  const b = boardWith("Scheduler.schedule", "Scheduler.postprocess");
  const h = await open({ board: b, light });
  const [s1, s2] = b.cards.map((c: any) => c.segments[0].id);
  await h.post({
    type: "stale",
    stale: { [s1]: { state: "lost" }, [s2]: { state: "changed", hiddenOnly: false, head: "f64d8210" } },
  } as any);
  await h.page.keyboard.press("Shift+!");
  await idle(h);
  await shot(h, "lost-01");
  const before = {
    banner: await h.page.locator(".banner").count(),
    cmiss: await h.page.locator(`.card[data-id="${b.cards[0].id}"] .cmiss`).count(),
  };
  await h.page.locator(".banner button", { hasText: "Update All" }).click();
  await idle(h);
  await h.page.locator(".cmiss button", { hasText: "Keep Old Version" }).click();
  await until(h, "Keep Old Version is saved", () => h.board().cards.some((c: any) => c.keepOld));
  await idle(h);
  await shot(h, "lost-02");
  const after = {
    banner: await h.page.locator(".banner").count(),
    cmiss: await h.page.locator(".cmiss").count(),
    cards: h.board().cards.map((c: any) => [c.keepOld ?? null, c.segments[0].version.commit]),
  };
  // Update All updates the changed card; the lost one says so until Keep Old Version keeps it at its pinned commit
  check(
    "lost a card whose code is gone says so, Update All updates the changed one and Keep Old Version keeps the lost one",
    before.banner === 1 &&
      before.cmiss === 1 &&
      after.banner === 0 &&
      after.cmiss === 0 &&
      JSON.stringify(after.cards) ===
        JSON.stringify([
          [true, "bb823b3c0ffee"],
          [null, "f64d8210"],
        ]),
    { before, after },
  );
  await h.page.context().close();
});

test("linkMergeSection", async () => {
  const h = await open({ board: boardWith("Scheduler.schedule", "Scheduler.postprocess"), light });
  await h.page.keyboard.press("Shift+!");
  await idle(h);
  // Arrow: select two cards, click Link
  await h.page.keyboard.press("Control+a");
  await h.page.locator('.bbar button[aria-label="Arrow"]').click();
  await until(h, "the arrow is added", () => h.board().links.length);
  await idle(h);
  const [A, B] = h.board().cards.map((c) => c.id),
    arrow = h.board().links.map((l) => [l.from.card, l.to.card]);
  check("linkMergeSection Arrow links the two selected cards", JSON.stringify(arrow) === JSON.stringify([[A, B]]), {
    arrow,
    A,
    B,
  });
  // Text: double-click empty space
  await h.page.mouse.dblclick(700, 120);
  await typingInto(h);
  await h.page.keyboard.type("Scheduler overview");
  await h.page.keyboard.press("Escape");
  await until(h, "the Text is saved", () => h.board().cards.some((c) => c.kind === "note"));
  await idle(h);
  await shot(h, "misc-01");
  // Merge: ⌥-drag the second card's title onto the first card's title
  const heads = h.page.locator(".card.ccard .chead");
  const a = await heads.nth(0).boundingBox(),
    b = await heads.nth(1).boundingBox();
  await h.page.mouse.move(b!.x + 60, b!.y + 10);
  await h.page.mouse.down();
  await h.page.keyboard.down("Alt");
  await h.page.mouse.move(a!.x + 80, a!.y + 12, { steps: 12 });
  await h.page.locator(".drophint", { hasText: "Release to merge" }).waitFor(); // ⌥ arms it at once
  const n0 = h.board().cards.length;
  await h.page.mouse.up();
  await h.page.keyboard.up("Alt");
  await until(h, "the drop merges the two cards", () => h.board().cards.length < n0);
  await idle(h);
  await shot(h, "misc-02-merged");
  const merged = h
    .board()
    .cards.map((c) => (c.kind === "code" ? c.segments.map((g) => g.symbol?.qual) : c.kind === "note" ? c.md : c.kind));
  // the arrow between the two cards would point from the merged card to itself: it goes
  check(
    "linkMergeSection ⌥-drop merges the two code cards into one with both snippets, beside the Text",
    JSON.stringify(merged) ===
      JSON.stringify(["Scheduler overview", ["Scheduler.schedule", "Scheduler.postprocess"]]) &&
      h.board().links.length === 0,
    { merged, links: h.board().links },
  );
  // Section, then collapse
  await h.page.keyboard.press("Control+a");
  await h.page.locator(".card.ccard .chead").first().click({ button: "right" });
  await h.page.locator(".ctx button").first().waitFor();
  await h.page.locator(".ctx button", { hasText: /^Move to New Section/ }).click();
  await typingInto(h);
  await h.page.keyboard.type("Scheduler");
  await h.page.keyboard.press("Enter");
  await until(h, "the section is named", () => h.board().sections.some((q) => q.title === "Scheduler"));
  await idle(h);
  await shot(h, "misc-03-section");
  const nb = h.board(),
    sec = {
      sections: nb.sections.map((q) => q.title),
      cards: nb.cards.map((c) => nb.sections.find((q) => q.id === nb.place[c.id]?.section)?.title ?? null),
    };
  check(
    "linkMergeSection Move to New Section puts the selected cards into a new named section",
    JSON.stringify(sec) === JSON.stringify({ sections: ["Scheduler"], cards: ["Scheduler", "Scheduler"] }),
    sec,
  );
  await h.page.context().close();
});

// Each column of a Compare can expand into its own call graph, and the Compare shows both marks
test("cmptree", async () => {
  const h = await open({ board: boardWith("LLMEngine.step", "Scheduler.schedule"), light });
  await h.page.keyboard.press("Shift+!");
  await idle(h);
  await h.page.keyboard.press("Control+a");
  await h.page.locator(".card.ccard .chead").first().click({ button: "right" });
  await h.page.locator(".ctx button", { hasText: "Compare" }).first().click();
  await until(h, "Compare makes a compare card", () => h.board().cards.some((c) => c.kind === "compare"));
  await idle(h);
  const calls = () => h.board().links.filter((l) => l.call).length;
  await h.page
    .locator(".card .call", { hasText: /^schedule$/ })
    .first()
    .click();
  await until(h, "schedule() expands from the left column", () => calls() > 0);
  await idle(h);
  await h.page.keyboard.press("Escape");
  await h.page
    .locator(".card .call", { hasText: /^can_allocate$/ })
    .first()
    .click();
  await until(h, "can_allocate() expands from the right column", () => calls() > 1);
  await idle(h);
  const b = h.board();
  const cmp = b.cards.find((c) => c.kind === "compare") as any;
  const marks = await h.page.locator(".card.cmp .chead .step").allTextContents();
  const ok = b.links.filter((l) => l.call).length === 2 && marks.length === 2 && new Set(marks).size === 2;
  check("cmptree", ok, JSON.stringify({ links: b.links.length, cols: cmp?.cols, marks }));
  await shot(h, "cmptree");
  await h.page.context().close();
});

// Deleting a link or card under a Compare is not refused (R → X → cl, R → Y → cr); the columns end up in two graphs
test("cmpdel", async () => {
  const b = boardWith("LLMEngine.step", "Scheduler.schedule", "Scheduler.postprocess");
  const [R, X, Y] = b.cards as any[];
  const P = b.place;
  P[X.id].x = P[R.id].x + 56;
  P[X.id].y = 700;
  P[Y.id].x = P[R.id].x + 56;
  P[Y.id].y = 1300;
  const cl = symCard(findSym("BlockManager.can_allocate").f, findSym("BlockManager.can_allocate").s);
  const cr = symCard(findSym("BlockManager.allocate").f, findSym("BlockManager.allocate").s);
  b.cards.push(cl, cr, { id: "k", kind: "compare", cols: [cl.id, cr.id] });
  b.place.k = { x: 1400, y: 700, w: 900 };
  const ln = (c: any, d: number) => c.segments[0].start + d;
  const call = (id: string, f: any, line: number, t: any) => ({
    id,
    from: { card: f.id, seg: f.segments[0].id, line },
    to: { card: t.id },
    call: { name: "f", col: 0 },
  });
  b.links.push(
    call("RX", R, ln(R, 2), X),
    call("RY", R, ln(R, 4), Y),
    call("Xcl", X, ln(X, 3), cl),
    call("Ycr", Y, ln(Y, 3), cr),
  );
  const h = await open({ board: b, light });
  await h.page.keyboard.press("Shift+!");
  await idle(h);
  const marks0 = await h.page.locator(".card.cmp .chead .step").allTextContents();
  // Delete the R → X link, then the common ancestor card
  await h.page.locator('path.lhit[data-link="RX"]').dispatchEvent("pointerdown", { button: 0 });
  await h.page.keyboard.press("Delete");
  await until(h, "the R → X link is deleted", () => !h.board().links.some((l) => l.id === "RX"));
  await idle(h);
  const rCard = h.page.locator(".card", { has: h.page.locator(".ctitle", { hasText: /^LLMEngine\.step$/ }) });
  await rCard.locator(".chead").click({ position: { x: 40, y: 10 } });
  await expect(rCard).toHaveClass(/\bsel\b/);
  await h.page.keyboard.press("Delete");
  await until(h, "the common ancestor card is deleted", () => !h.board().cards.some((c) => c.id === R.id));
  await idle(h);
  const nb = h.board();
  const marks = await h.page.locator(".card.cmp .chead .step").allTextContents();
  const ok =
    nb.cards.length === 5 &&
    nb.links.map((l) => l.id).join() === "Xcl,Ycr" &&
    marks0.join() === "A,A" &&
    new Set(marks).size === 2;
  check("cmpdel", ok, JSON.stringify({ cards: nb.cards.length, links: nb.links.map((l) => l.id), marks0, marks }));
  await shot(h, "cmpdel");
  await h.page.context().close();
});

// Relocate changes the snippet, or the snippet moved at HEAD: Link endpoints, Sidenotes and hidden lines follow; moves don't go on the undo stack
test("rebase", async () => {
  const b = boardWith("Scheduler.schedule", "Scheduler.postprocess");
  const [A, B] = b.cards as any[];
  const sa = A.segments[0],
    sb = B.segments[0];
  sa.hidden = [[sa.start + 8, sa.start + 9]];
  b.links.push({
    id: "L",
    from: { card: B.id, seg: sb.id, line: sb.start + 2 },
    to: { card: A.id, seg: sa.id, line: sa.start + 3 },
  } as any);
  b.sidenotes.push({
    id: "n1",
    kind: "text",
    md: "x",
    at: { card: B.id, seg: sb.id, lines: [sb.start + 2, sb.start + 2] },
  } as any);
  const h = await open({ board: b, light });
  // A moves down 5 lines as a whole (HEAD changed, content didn't)
  await h.post({
    type: "stale",
    stale: { [sa.id]: { state: "moved", start: sa.start + 5, end: sa.end + 5, version: sa.version } },
  });
  const segOf = (i: number) => (h.board().cards[i] as any).segments[0];
  await until(h, "the host's move reaches the board", () => segOf(0).start === sa.start + 5);
  // B is Relocated 7 lines down (same content)
  await h.post({
    type: "replaceSegment",
    card: B.id,
    seg: { ...sb, start: sb.start + 7, end: sb.end + 7 },
    view: viewOf(sb),
  } as any);
  await until(h, "the Relocate reaches the board", () => segOf(1).start === sb.start + 7);
  await h.page.keyboard.press("Control+z");
  await h.page.keyboard.press("Meta+z"); // undoes only the Relocate; the move must not be undone
  await until(h, "undo takes the Relocate back", () => segOf(1).start !== sb.start + 7);
  await idle(h);
  const nb = h.board() as any,
    L = nb.links[0],
    na = nb.cards[0].segments[0],
    nbs = nb.cards[1].segments[0];
  const ok =
    na.start === sa.start + 5 &&
    JSON.stringify(na.hidden) === JSON.stringify([[sa.start + 13, sa.start + 14]]) &&
    L.to.line === sa.start + 8 &&
    nbs.start === sb.start &&
    L.from.line === sb.start + 2 &&
    nb.sidenotes[0].at.lines[0] === sb.start + 2;
  // Relocate again (no undo): Link start and Sidenote follow to the new lines
  await h.post({
    type: "replaceSegment",
    card: B.id,
    seg: { ...sb, start: sb.start + 7, end: sb.end + 7 },
    view: viewOf(sb),
  } as any);
  await until(h, "the second Relocate reaches the board", () => segOf(1).start === sb.start + 7);
  await idle(h);
  const nb2 = h.board() as any;
  const ok2 = nb2.links[0].from.line === sb.start + 9 && nb2.sidenotes[0].at.lines[0] === sb.start + 9;
  check(
    "rebase",
    ok && ok2,
    JSON.stringify({
      aStart: na.start - sa.start,
      hidden: na.hidden?.[0]?.map((x: number) => x - sa.start),
      to: L.to.line - sa.start,
      bAfterUndo: nbs.start - sb.start,
      from: nb2.links[0].from.line - sb.start,
      note: nb2.sidenotes[0].at.lines[0] - sb.start,
    }),
  );
  await h.page.context().close();
});

// Host sync is not an undo step: a change, then a stale "moved" from the host, then ⌘Z undoes the change and the lines stay where the host put them
test("syncundo", async () => {
  const b = boardWith("Scheduler.schedule", "Scheduler.postprocess");
  const [A, B] = b.cards as any[];
  const sa = A.segments[0],
    name0 = b.name;
  b.links.push({ id: "L", from: { card: B.id }, to: { card: A.id, seg: sa.id, line: sa.start + 3 } } as any);
  b.sidenotes.push({
    id: "n1",
    kind: "text",
    md: "x",
    at: { card: A.id, seg: sa.id, lines: [sa.start + 2, sa.start + 2] },
  } as any);
  const h = await open({ board: b, light });
  await h.post({ type: "rename", name: "Renamed" });
  await until(h, "the rename reaches the board", () => h.board().name === "Renamed");
  await h.post({
    type: "stale",
    stale: { [sa.id]: { state: "moved", start: sa.start + 5, end: sa.end + 5, version: sa.version } },
  });
  await until(
    h,
    "the host's move reaches the board",
    () => (h.board().cards[0] as any).segments[0].start === sa.start + 5,
  );
  await h.page.keyboard.press("Meta+z");
  await until(h, "undo takes the rename back", () => h.board().name === name0);
  await idle(h);
  const at = (x: any) => ({
    name: x.name,
    start: x.cards[0].segments[0].start - sa.start,
    to: x.links[0].to.line - sa.start,
    note: x.sidenotes[0].at.lines[0] - sa.start,
  });
  const u = at(h.board());
  await h.page.keyboard.press("Meta+Shift+z");
  await until(h, "redo renames again", () => h.board().name === "Renamed");
  await idle(h);
  const r = at(h.board());
  // nothing older to undo: the move stays (the second undo is the trigger: once idle, whatever it changed has reached the host)
  await h.page.keyboard.press("Meta+z");
  await h.page.keyboard.press("Meta+z");
  await until(h, "undo takes the rename back again", () => h.board().name === name0);
  await idle(h);
  const u2 = at(h.board());
  const moved = (x: any) => x.start === 5 && x.to === 8 && x.note === 7;
  const ok = u.name === name0 && moved(u) && r.name === "Renamed" && moved(r) && u2.name === name0 && moved(u2);
  check("sync-undo", ok, JSON.stringify({ u, r, u2 }));
  await h.page.context().close();
});

// Autosave sends item-level patches: the host copy built from patches must equal the board the page holds.
// A patch the host turned down makes the page send the whole board (full patch) with the next change.
test("patchsave", async () => {
  const b = boardWith("Scheduler.schedule", "Scheduler.postprocess", "LLMEngine.step");
  const [A, B] = b.cards;
  b.links.push({ id: "L", from: { card: A.id }, to: { card: B.id } });
  b.sidenotes.push({ id: "n1", kind: "text", md: "x", at: { card: A.id } } as any);
  let fail = false;
  const patches: any[] = [];
  const h = await open({
    board: b,
    light,
    on: (m, reply) => {
      if (m.type !== "patch") return false;
      patches.push(m.patch);
      if (!fail) return false;
      fail = false;
      void reply(m.req!, undefined, "disk full");
      return true;
    },
  });
  const head = (i: number) => h.page.locator(".card").nth(i).locator(".chead");
  /** the next patch after this many */
  const sent = async (what: string, n: number) => {
    await until(h, what, () => patches.length > n);
    await idle(h);
  };
  // selecting is not a change: the click is the trigger, so once the board is idle a patch would have been sent
  await head(0).click({ position: { x: 60, y: 10 } });
  await idle(h);
  const idleCount = patches.length;
  await h.page.keyboard.press("ArrowRight");
  await sent("the nudge is sent", idleCount);
  const nudge = patches.at(-1); // the first change also numbers the cards (head.born)
  let n = patches.length;
  await h.page.keyboard.press("Meta+Shift+BracketRight");
  await sent("bring to front is sent", n); // bring to front: order only
  const front = patches.at(-1);
  // the card that is on screen (the third one sticks out past the right edge, and the canvas does not scroll to it)
  n = patches.length;
  await head(0).click({ position: { x: 60, y: 10 } });
  await h.page.keyboard.press("Backspace");
  await sent("the delete is sent", n);
  const del = patches.at(-1);
  n = patches.length;
  await h.page.keyboard.press("Meta+z");
  await sent("the undo is sent", n);
  n = patches.length;
  await h.post({ type: "rename", name: "Renamed" });
  await sent("the rename is sent", n);
  const ren = patches.at(-1);
  const inc = structuredClone(h.board());
  fail = true;
  n = patches.length;
  await head(0).click({ position: { x: 60, y: 10 } });
  await h.page.keyboard.press("ArrowDown");
  await sent("the refused nudge is sent", n);
  const failed = patches.at(-1);
  const toast = await h.page.locator(".toast").textContent();
  // no further edit: the board sends itself whole once, RESEND_DELAY later
  await until(h, "the board sends itself whole", () => patches.at(-1)?.full, RESEND_DELAY + 1500);
  await idle(h);
  const full = patches.at(-1),
    resends = patches.length - patches.indexOf(failed) - 1;
  const { applyPatch } = await import("@codeboard/core");
  const moved = Object.keys(failed?.place?.set ?? {})[0];
  const y = (x: any) => x.place[moved].y;
  const y0 = y(inc);
  applyPatch(inc, failed);
  const twice = y(h.board()) === y(inc) && full?.place?.set?.[moved]?.y === y(inc) && y(inc) !== y0 && resends === 1;
  const ok =
    idleCount === 0 &&
    nudge?.place &&
    !nudge.cards &&
    Object.keys(nudge.place.set).length === 1 &&
    front?.cards?.order &&
    !front.cards.set &&
    del?.cards?.del?.length === 1 &&
    ren?.head?.name === "Renamed" &&
    !ren.cards &&
    /Couldn't save the board: disk full/.test(toast ?? "") &&
    full?.full === true &&
    twice;
  check(
    "patch-save",
    ok,
    JSON.stringify({
      idle: idleCount,
      nudge: nudge && Object.keys(nudge),
      front: front && Object.keys(front.cards ?? {}),
      del: del && Object.keys(del),
      ren: ren && Object.keys(ren),
      toast,
      full: !!full?.full,
      resends,
      twice,
    }),
  );
  await h.page.context().close();
});

// A shared card changed on another board (host "shared" message): applied as a sync (no patch back, not undoable).
// Undoing a local change to that card afterwards keeps the other board's version and says so
test("sharedsync", async () => {
  const b = boardWith("Scheduler.schedule", "Scheduler.postprocess");
  const [A, B] = b.cards as any[];
  const patches: any[] = [];
  const h = await open({
    board: b,
    light,
    on: (m) => {
      if (m.type === "patch") patches.push(m);
      return false;
    },
  });
  const head = (i: number) => h.page.locator(".card").nth(i).locator(".chead");
  await head(0).click({ position: { x: 60, y: 10 } });
  await h.page.keyboard.press("Alt+z");
  await until(h, "the wrap is sent", () => patches.length);
  await idle(h);
  const wrote = patches.at(-1)?.patch.cards?.set?.[0]?.wrap === true;
  const n0 = patches.length;
  // Another board renames the card (its copy has our wrap); the host's copy already has it
  const sc = {
    card: { ...structuredClone(A), wrap: true, title: "Remote" },
    sidenotes: [{ id: "rn", kind: "text", md: "remote note", at: { card: A.id } }],
    items: [A.id, "rn"],
  } as any;
  putShared(h.board(), structuredClone(sc));
  await h.post({ type: "shared", cards: [sc] });
  // the other board's version shows; a patch back would be in flight by the time the board is idle
  await expect(h.page.locator(".card").nth(0).locator(".ctitle")).toHaveText("Remote");
  await idle(h);
  const echo = patches.length - n0; // must be 0
  const title = await h.page.locator(".card").nth(0).locator(".ctitle").textContent();
  await h.page.keyboard.press("Meta+z");
  const toast = await h.page.locator(".toast").textContent();
  await idle(h);
  const after = h.board().cards.find((c) => c.id === A.id) as any;
  const undoPatch = patches.slice(n0).find((m) => m.undo);
  // A local card still undoes normally, without the toast
  await h.page
    .locator(".toast")
    .evaluate((e) => e.remove())
    .catch(() => {});
  const wrapB = () => (h.board().cards.find((c) => c.id === B.id) as any).wrap;
  await head(1).click({ position: { x: 60, y: 10 } });
  await h.page.keyboard.press("Alt+z");
  await until(h, "the local wrap is sent", wrapB);
  await idle(h);
  await h.page.keyboard.press("Meta+z");
  await until(h, "undo takes the local wrap back", () => !wrapB());
  await idle(h);
  const local = (h.board().cards.find((c) => c.id === B.id) as any).wrap;
  const toast2 = await h.page.locator(".toast").count();
  const ok =
    wrote &&
    echo === 0 &&
    title === "Remote" &&
    /not undone/.test(toast ?? "") &&
    after.wrap === true &&
    after.title === "Remote" &&
    h.board().sidenotes.some((n) => n.id === "rn") &&
    !local &&
    toast2 === 0;
  check(
    "shared-sync",
    ok,
    JSON.stringify({
      wrote,
      echo,
      title,
      toast,
      after: { wrap: after.wrap, title: after.title },
      undoPatch: !!undoPatch,
      local,
      toast2,
    }),
  );
  await h.page.context().close();
});

// After Update, Sidenotes and highlights follow edited lines instead of being treated as deleted
test("follow", async () => {
  const b = boardWith("Scheduler.schedule");
  const c = b.cards[0] as any,
    s0 = c.segments[0];
  s0.hl = [s0.start + 3, s0.start + 6];
  s0.hidden = [[s0.start + 8, s0.start + 9]];
  b.sidenotes.push({
    id: "n1",
    kind: "text",
    md: "on the edited line",
    at: { card: c.id, seg: s0.id, lines: [s0.start + 3, s0.start + 3] },
  } as any);
  const h = await open({ board: b, light });
  await h.post({ type: "stale", stale: { [s0.id]: { state: "changed", hiddenOnly: false, head: "f64d8210" } } } as any);
  await h.page.locator(".banner button", { hasText: "Update All" }).click();
  await until(
    h,
    "Update All pins the new version",
    () => JSON.stringify((h.board().cards[0] as any).segments[0].version) !== JSON.stringify(s0.version),
  );
  await idle(h);
  const nb = h.board() as any,
    ns = nb.cards[0].segments[0],
    n = nb.sidenotes[0];
  const ok =
    JSON.stringify(n.at.lines) === JSON.stringify([s0.start + 3, s0.start + 3]) &&
    !n.lineRemoved &&
    JSON.stringify(ns.hl) === JSON.stringify(s0.hl) &&
    JSON.stringify(ns.hidden) === JSON.stringify(s0.hidden);
  check(
    "follow",
    ok,
    JSON.stringify({
      at: n.at,
      removed: n.lineRemoved ?? false,
      hl: ns.hl,
      hidden: ns.hidden,
      version: ns.version.commit,
    }),
  );
  await h.page.context().close();
});

// Draw the inner frame first, then the outer one; the outer frame is the parent
test("secout", async () => {
  const h = await open({ board: boardWith("LLMEngine.step"), light });
  const r = await h.page.locator(".card").first().boundingBox();
  const draw = async (pad: number, name: string) => {
    await h.page.locator('.bbar button[aria-label="Section"]').click();
    await h.page.mouse.move(r!.x - pad, r!.y - pad - 20);
    await h.page.mouse.down();
    await h.page.mouse.move(r!.x + r!.width + pad, r!.y + r!.height + pad, { steps: 8 });
    await h.page.mouse.up();
    await typingInto(h);
    await h.page.keyboard.type(name);
    await h.page.keyboard.press("Enter");
    await until(h, `the section ${name} is saved`, () => h.board().sections.some((q) => q.title === name));
    await idle(h);
  };
  await draw(30, "Inner");
  await draw(90, "Outer");
  const ss = h.board().sections,
    inner = ss.find((q) => q.title === "Inner")!,
    outer = ss.find((q) => q.title === "Outer")!;
  const ok = inner.parent === outer.id && !outer.parent && h.board().place[h.board().cards[0].id]?.section === inner.id;
  check(
    "secout",
    ok,
    JSON.stringify(
      ss
        .map((q) => [q.title, q.parent ? ss.find((x) => x.id === q.parent)!.title : null])
        .concat([["card", h.board().place[h.board().cards[0].id]?.section === inner.id ? "Inner" : "?"]]),
    ),
  );
  await shot(h, "secout");
  await h.page.context().close();
});

// Subtrees expanded by Walkthrough are not written to the board
test("walkview", async () => {
  const h = await open({ board: boardWith("LLMEngine.step"), light });
  await h.page
    .locator(".card .src .call", { hasText: /^schedule$/ })
    .first()
    .click();
  await until(h, "schedule() expands", () => h.board().cards.length > 1);
  await idle(h);
  const root = h.board().cards[0].id;
  await h.page.locator(".card").first().locator(".chead").click({ button: "right" });
  await h.page.locator('.ctx button:has(.lb:text-is("Call Graph"))').hover();
  await h.page
    .locator(".ctx button", { hasText: /Collapse/ })
    .first()
    .click();
  await until(h, "the collapse is saved", () => h.board().place[root]?.collapsed);
  await idle(h);
  const before = JSON.stringify(h.board());
  // Walkthrough's expanded subtrees must not be saved: each key is the trigger, so once the board is idle a save would have been sent
  await h.page.keyboard.press("Escape");
  await h.page.keyboard.press("p");
  await idle(h);
  const shown = await h.page.locator(".card").count();
  await h.page.keyboard.press("ArrowRight");
  await idle(h);
  const during = JSON.stringify(h.board());
  await h.page.keyboard.press("Escape");
  await idle(h);
  const after = JSON.stringify(h.board()),
    hidden = await h.page.locator(".card").count();
  const strip = (j: string) => {
    const o = JSON.parse(j);
    delete o.cam;
    return JSON.stringify(o);
  };
  const ok =
    shown === 2 &&
    hidden === 1 &&
    strip(before) === strip(during) &&
    strip(before) === strip(after) &&
    JSON.parse(after).place[root]?.collapsed === true;
  check("walkview", ok, JSON.stringify({ shown, hidden, savedChanged: strip(before) !== strip(during) }));
  await h.page.context().close();
});

test("palette", async () => {
  const h = await open({ board: boardWith("LLMEngine.step"), light });
  await h.page.keyboard.press("Control+k");
  await h.page.keyboard.press("Meta+k");
  await h.page.locator(".palette input:focus").waitFor();
  await shot(h, "pal-01-entry");
  await h.page.keyboard.type("alloc");
  await idle(h); // the results come from the host
  await shot(h, "pal-02-query");
  const searched = h.sent
    .filter((m) => m.type === "search")
    .map((m: any) => m.q)
    .at(-1);
  await h.page.keyboard.press("Enter");
  await until(h, "the picked result is placed", () => h.board().cards.length > 1);
  await expect(h.page.locator(".palette")).toHaveCount(0);
  await shot(h, "pal-03-placed");
  const placed = qualOf(h.board(), h.board().cards[1].id);
  check(
    "palette the typed query goes to the host and Enter places the first result as a card",
    searched === "alloc" && /alloc/i.test(placed ?? ""),
    { searched, placed },
  );
  await h.page.context().close();
});

test("peek", async () => {
  const h = await open({ board: boardWith("Scheduler.schedule"), light });
  await h.page.locator(".card .src .call", { hasText: "can_allocate" }).first().hover();
  await h.page.locator(".pop.k-peek .pt").waitFor(); // PEEK_DELAY after the hover, filled from the host
  await shot(h, "peek-01");
  const pop = await h.page.locator(".pop.k-peek").evaluate((e) => ({
    title: e.querySelector(".pt")?.textContent,
    sig: e.querySelector(".pk-sig")?.textContent,
    rows: e.querySelectorAll(".pl").length,
    code: e.querySelector(".pl.hl")?.textContent,
  }));
  check(
    "peek hovering a call previews its definition",
    /block_manager\.py:\d+/.test(pop.title ?? "") &&
      /def can_allocate/.test(pop.sig ?? "") &&
      pop.rows > 0 &&
      /def can_allocate/.test(pop.code ?? ""),
    pop,
  );
  await h.page.context().close();
});

// field / function / module / library previews
test("peekkinds", async () => {
  const h = await open({ board: boardWith("LLMEngine.__init__", "ModelRunner.__init__"), light });
  type Info = Record<string, string | boolean | null | undefined>;
  const cases: [string, string, string, string, (i: Info) => boolean][] = [
    // a field: the class it is in, its line highlighted
    [
      "field",
      "LLMEngine.__init__",
      "config.kvcache_block_size",
      "kvcache_block_size",
      (i) =>
        /config\.py:\d+/.test(String(i.title)) &&
        /kvcache_block_size: int/.test(String(i.sig)) &&
        i.head === "class Config" &&
        !!i.hl &&
        String(i.rows).split(",").includes(String(i.hl)),
    ],
    // a function: its first lines and how many more
    [
      "function",
      "ModelRunner.__init__",
      "load_model(self.model",
      "load_model",
      (i) =>
        /loader\.py:\d+/.test(String(i.title)) &&
        /def load_model/.test(String(i.sig)) &&
        /more lines/.test(String(i.more)) &&
        !i.lib,
    ],
    // a module: its docs, no lines, tagged as a library
    [
      "module",
      "LLMEngine.__init__",
      "mp.get_context",
      "mp",
      (i) => i.sig === "(module) mp" && i.doc === true && i.rows === "" && !!i.lib,
    ],
    // a library function: its lines, tagged as a library
    [
      "library",
      "LLMEngine.__init__",
      "mp.get_context",
      "get_context",
      (i) => /context\.py:186/.test(String(i.title)) && /def get_context/.test(String(i.sig)) && !!i.rows && !!i.lib,
    ],
  ];
  for (const [k, card, line, word, ok] of cases) {
    await h.page.mouse.move(5, 5);
    await expect(h.page.locator(".pop.k-peek")).toHaveCount(0);
    await idle(h);
    await hoverWord(h, card, line, word);
    const pop = h.page.locator(".pop.k-peek");
    await pop.locator(".pt").waitFor();
    await idle(h); // PEEK_DELAY after the hover, filled from the host
    const info = await pop.evaluate((e) => ({
      title: e.querySelector(".pt")?.textContent,
      sig: e.querySelector(".pk-sig")?.textContent,
      doc: !!e.querySelector(".pk-doc"),
      rows: [...e.querySelectorAll(".pl .no")].map((x) => x.textContent).join(","),
      hl: e.querySelector(".pl.hl .no")?.textContent,
      more: e.querySelector(".pk-more")?.textContent,
      lib: e.querySelector(".lib-tag")?.textContent,
      head: e.querySelector(".pk-head")?.textContent,
    }));
    check(`peekkinds the ${k} preview`, ok(info), info);
    await shot(h, `peekkinds-${k}`);
  }
  await h.page.context().close();
});

// library calls get no underline and don't expand on click; ⌥-click / context menu Expand Anyway; restored after adding to Study Scope
test("libcalls", async () => {
  const h = await open({ board: boardWith("ModelRunner.warmup_model"), light });
  const lib = h.page.locator(`.card .src .call[data-p="torch"]`).first();
  const deco = (el = lib) => el.evaluate((e) => getComputedStyle(e).textDecorationLine);
  const looks = {
    lib: await h.page.locator(".card .src .call[data-p]").count(),
    project: await h.page.locator(".card .src .call:not([data-p])").count(),
    libDeco: await deco(),
    projectDeco: await deco(h.page.locator(".card .src .call:not([data-p])").first()),
  };
  check(
    "libcalls library calls are not underlined, project calls are",
    looks.lib > 0 && looks.project > 0 && looks.libDeco === "none" && /underline/.test(looks.projectDeco),
    looks,
  );
  await shot(h, "libcalls-01");
  await lib.click();
  await idle(h); // a library call does not expand: an expand would be in flight by now
  const click = { cards: h.board().cards.length, expands: h.sent.filter((m) => m.type === "expand").length };
  check("libcalls a click on a library call does not expand it", click.cards === 1 && click.expands === 0, click);
  await lib.click({ modifiers: ["Alt"] });
  await until(h, "⌥-click expands anyway", () => h.sent.some((m) => m.type === "expand"));
  await idle(h);
  const asked = h.sent.filter((m) => m.type === "expand").map((m: any) => m.name),
    name = await lib.textContent();
  check("libcalls ⌥-click expands a library call anyway", asked.length === 1 && asked[0] === name, { asked, name });
  await h.page.mouse.move(5, 5);
  await idle(h);
  await lib.click({ button: "right" });
  await h.page.locator(".ctx button").first().waitFor();
  await idle(h);
  const menu = await h.page.locator(".ctx button").allTextContents();
  check(
    "libcalls the library call's menu offers Expand Anyway and adding its package to the Study Scope",
    menu.some((t) => /^Expand Anyway/.test(t)) && menu.includes('Add "torch" to Study Scope'),
    { menu },
  );
  await shot(h, "libcalls-02-menu");
  await h.page.locator(".ctx button", { hasText: /^Add "torch" to Study Scope$/ }).click();
  await until(h, "the Study Scope setting is sent", () => h.sent.some((m) => m.type === "setSetting"));
  await idle(h);
  const set = h.sent.filter((m) => m.type === "setSetting"),
    decoNow = await deco();
  check(
    "libcalls in the Study Scope the package's calls are project calls again",
    JSON.stringify(set) === JSON.stringify([{ type: "setSetting", key: "studyScope", value: ["torch"] }]) &&
      /underline/.test(decoNow),
    { set, decoNow },
  );
  await shot(h, "libcalls-03-scoped");
  await h.page.context().close();
});

// dragging onto an existing card also offers variable candidates
test("attachvars", async () => {
  const h = await open({ board: boardWith("ModelRunner.__init__", "Qwen3ForCausalLM"), light });
  const c = await callEl(h, "Qwen3ForCausalLM").boundingBox();
  const t = await h.page.locator(".card").nth(1).locator(".chead").boundingBox();
  await h.page.mouse.move(c!.x + 10, c!.y + c!.height / 2);
  await h.page.mouse.down();
  await h.page.mouse.move(t!.x + 60, t!.y + 40, { steps: 10 });
  await h.page.mouse.up();
  await until(h, "the call is attached to the card", () => h.board().links.length);
  await idle(h);
  const ls = h.board().links;
  check("attachvars", ls.length === 1 && ls[0].call && ls[0].call.cands?.length, JSON.stringify(ls.map((l) => l.call)));
  await shot(h, "attachvars");
  await h.page.context().close();
});

test("themes", async () => {
  // Themes: switch through 8 materials × light/dark in Settings, one board screenshot each.
  // Board: entry function with two expanded calls (laid out to the right, variables on links), a Note, a Section, a labeled arrow and a heading; entry card selected and a toast shown
  const b = boardWith("LLMEngine.step");
  for (const [q, name] of [
    ["Scheduler.schedule", "schedule"],
    ["ModelRunner.run", "call"],
  ] as const) {
    const s0 = findSym(q);
    const c = symCard(s0.f, s0.s);
    put(b, c, 0, 0);
    const seg = (b.cards[0] as any).segments[0],
      i = seg.text.findIndex((t: string) => t.includes(`.${name}(`));
    b.links.push({
      id: `c${b.links.length}`,
      from: { card: b.cards[0].id, seg: seg.id, line: seg.start + i },
      to: { card: c.id },
      call: { name, col: seg.text[i].indexOf(`.${name}(`) + 1 },
    } as any);
  }
  const [a] = b.cards;
  const kids = b.links.filter((l) => l.call).map((l) => l.to.card);
  b.place[a.id] = { x: 80, y: 200, w: 520 };
  kids.forEach((id, i) => {
    b.place[id] = { x: 760, y: 60 + i * 420, w: 470, h: i ? 264 : 324 };
  }); // code area height: 300 / 360 tall in Warm Ink
  const vars = [[{ a: "seqs" }, { a: "is_prefill" }], [{ a: "token_ids", ret: true }]];
  b.links
    .filter((l) => l.call)
    .forEach((l, i) => {
      l.call!.vars = vars[i] ?? [];
    });
  const note = {
    id: "n1",
    kind: "note" as const,
    md: "# Why chunked prefill\nKeeps memory **bounded**: prefill admits waiting seqs until the `max_num_batched_tokens` budget runs out.",
    look: "note",
  };
  const title = { id: "t1", kind: "note" as const, md: "Engine loop", look: "text", size: "title" as const };
  b.cards.push(note, title);
  b.place[note.id] = { x: 110, y: 520, w: 360, section: "sec1" };
  b.place[title.id] = { x: 70, y: 70, w: 300 };
  b.sections.push({ id: "sec1", title: "Engine", x: 50, y: 160, w: 600, h: 560, color: "sand" });
  b.place[a.id].section = "sec1";
  b.links.push({ id: "l1", from: { card: note.id }, to: { card: a.id }, style: { color: "blue" }, label: "why" });
  b.cam = { x: 120, y: 60, z: 0.92 };
  const h = await open({ board: b, light: false });
  await idle(h);
  await h.page.keyboard.press("Escape");
  const poke = async () => {
    // Show a toast (click Arrow with no card selected), then select the entry card (click its header)
    await h.page.keyboard.press("Escape");
    await h.page.mouse.click(700, 24); // empty canvas: clear selection
    await h.page.locator('.bbar .tbtn[aria-label="Arrow"]').click();
    // An empty spot on the card header (header layout varies by material; find a point that hits .chead itself)
    const pt = await h.page.evaluate((id) => {
      const card = document.querySelector(`.card[data-id="${id}"]`)!,
        hd = card.querySelector(".chead")!,
        r = card.getBoundingClientRect();
      for (let y = r.top + 3; y < r.top + 120; y += 4)
        for (let x = r.right - 40; x > r.left; x -= 6) {
          const e = document.elementFromPoint(x, y);
          if (e === hd || e?.matches(".chead .grow, .cband, .cband .cname")) return { x, y };
        }
      return { x: r.left + 4, y: r.top + 4 };
    }, a.id);
    await h.page.mouse.click(pt.x, pt.y);
  };
  await poke();
  await idle(h);
  const poked = {
    cards: h.board().cards.length,
    toast: await h.page.locator(".toast").count(),
    selected: await h.page.locator(".card.sel").count(),
  };
  check(
    "themes the toast shows and the entry card is selected",
    poked.cards === 5 && poked.toast === 1 && poked.selected === 1,
    poked,
  );
  const mode = async (m: "light" | "dark") => {
    await h.page.evaluate((c) => {
      document.body.className = c;
    }, `vscode-${m}`);
    await idle(h);
  };
  const look = () =>
    h.page.evaluate(() => ({
      look: document.documentElement.dataset.look,
      theme: document.documentElement.dataset.theme,
    }));
  const applied: { m: string; name: string; set: unknown; look: unknown; selected: number }[] = [];
  for (const m of ["light", "dark"] as const) {
    await mode(m);
    await h.page.mouse.move(5, 450);
    await shot(h, `theme-${m}-warm-ink-base`);
    await h.page.keyboard.press("Meta+,");
    await h.page.locator(".settings").waitFor();
    await shot(h, `theme-${m}-settings`);
    if (m === "light") {
      await h.page.keyboard.press("Escape");
      await h.page.keyboard.press("?");
      await h.page.locator(".keys").waitFor();
      await shot(h, `theme-${m}-keys-overlay`);
      await h.page.locator(".keys .tlink").click();
      await h.page.locator(".settings").waitFor();
      await idle(h);
      const fromKeys = {
        settings: await h.page.locator(".settings").count(),
        overlay: await h.page.locator(".keys").count(),
      };
      check(
        "themes Search… in the ? overlay opens Settings and closes the overlay",
        fromKeys.settings === 1 && fromKeys.overlay === 0,
        fromKeys,
      );
      await h.page.locator(".st-filter").scrollIntoViewIfNeeded();
      await shot(h, `theme-${m}-settings-keys`);
      await h.page.locator(".st-filter").fill("zoom");
      await idle(h);
      await shot(h, `theme-${m}-settings-keys-zoom`);
      await h.page.locator(".st-filter").fill("");
      await h.page.locator(".st-filter").press("Escape");
      await idle(h);
      check("themes Esc in the shortcut filter closes Settings", (await h.page.locator(".settings").count()) === 0);
      await h.page.keyboard.press("Meta+,");
      await h.page.locator(".settings").waitFor();
    }
    const n = await h.page.locator(".st-sw").count();
    for (let i = 0; i < n; i++) {
      const sw = h.page.locator(".st-sw").nth(i);
      const name = (await sw.locator(".st-swn").textContent())!.toLowerCase().replace(/ /g, "-");
      const sets = h.sent.length;
      await sw.click();
      await until(h, `the ${name} theme is applied`, () => h.sent.slice(sets).some((x) => x.type === "setSetting"));
      await idle(h);
      if (i === n - 1) await shot(h, `theme-${m}-settings-${name}`);
      await h.page.keyboard.press("Escape");
      await idle(h);
      await poke();
      await idle(h);
      applied.push({
        m,
        name,
        set: h.sent.slice(sets).filter((x) => x.type === "setSetting"),
        look: await look(),
        selected: await h.page.locator(".card.sel").count(),
      });
      await h.page.mouse.move(5, 450);
      await shot(h, `theme-${m}-${i}-${name}`);
      await h.page.keyboard.press("Meta+,");
      await h.page.locator(".settings").waitFor();
    }
    await h.page.locator(".st-sw").first().click();
    await h.page.keyboard.press("Escape");
  }
  // each swatch sends its theme to the host and puts it on the page (html[data-look]); light / dark follows VS Code (html[data-theme])
  const wrong = applied.filter((a) => {
    const set = a.set as { key: string; value: string }[],
      l = a.look as { look: string; theme: string };
    return set.length !== 1 || set[0].key !== "theme" || l.look !== set[0].value || l.theme !== a.m || a.selected !== 1;
  });
  const ids = new Set(applied.map((a) => (a.set as { value: string }[])[0]?.value));
  check(
    "themes every swatch applies its own theme, in light and dark",
    applied.length >= 16 && ids.size === applied.length / 2 && wrong.length === 0,
    { n: applied.length, ids: [...ids], wrong },
  );
  const kept = { links: h.board().links.length, sections: h.board().sections.length, cards: h.board().cards.length };
  check(
    "themes switching themes leaves the board's content alone",
    kept.links === 3 && kept.sections === 1 && kept.cards === 5,
    kept,
  );
  await h.page.context().close();
});

/** Move the mouse to the middle of `word` on the line (containing `line`) in a card */
async function hoverWord(h: Host, card: string, line: string, word: string) {
  const pt = await h.page.evaluate(
    ([card, line, word]) => {
      for (const c of document.querySelectorAll(".card")) {
        if (!c.querySelector(".chead")?.textContent?.includes(card)) continue;
        for (const l of c.querySelectorAll(".src .l")) {
          const t = l.textContent ?? "";
          const i = t.indexOf(line);
          if (i < 0) continue;
          const at = i + line.indexOf(word) + 1;
          const w = document.createTreeWalker(l, NodeFilter.SHOW_TEXT);
          let n = 0;
          for (let x = w.nextNode() as Text | null; x; x = w.nextNode() as Text | null) {
            if (n + x.length > at) {
              const r = document.createRange();
              r.setStart(x, at - n);
              r.setEnd(x, at - n + 1);
              const b = r.getBoundingClientRect();
              return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
            }
            n += x.length;
          }
        }
      }
      return null;
    },
    [card, line, word],
  );
  if (!pt) throw new Error(`hoverWord: ${line} not found`);
  await h.page.mouse.move(pt.x - 3, pt.y);
  await h.page.mouse.move(pt.x, pt.y, { steps: 2 });
}
