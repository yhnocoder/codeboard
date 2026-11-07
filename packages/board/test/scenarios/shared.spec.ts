// Shared cards: two boards in two browsers on the real host (realhost.ts) relaying patches, shared updates, the card clipboard,
// Delete Everywhere and the "⧉ N boards" / "← N" info.
//  sharedHighlightBoardOnly  a board-only sidenote on a shared card is a Highlight on its own board only: made board-only it takes
//                            its Highlight off the shared card (the other board no longer shows it), and when the other board
//                            removes or grows the shared Highlight next to it, it stays, shown, with no dangling reference
import * as fs from "node:fs";
import * as path from "node:path";
import { danglingRefs, emptyBoard, shownRanges, type Board, type CodeCard } from "@codeboard/core";
import { shot, symCard, findSym, put, newerVersion, type Host } from "../harness";
import { test, check, light, expect, until, idle, hostBoards } from "../fixtures";

/** One browser per board, both open on the real host; the diff of an update comes from the harness (a made-up newer version) */
async function sharedHost(boards: Board[]) {
  const opened: { id: string; card?: string; line?: number }[] = [];
  const run = await hostBoards(boards, {
    page: {
      light,
      w: 1200,
      h: 800,
      on: async (m, reply) => {
        if (m.type === "openBoard") opened.push({ id: m.id, card: m.card, line: m.line });
        if (m.type !== "diff") return false;
        await reply(m.req, newerVersion(m.seg));
        return true;
      },
    },
  });
  const hosts = new Map<string, Host>();
  for (const b of boards) hosts.set(b.id, await run.open(b.id));
  const store = run.host.store;
  return {
    store,
    dir: store.dir(),
    hosts,
    opened,
    clip: () => run.host.hub.clip,
    close: async () => {
      for (const h of hosts.values()) await h.page.context().close();
    },
  };
}

/** Paste the way ⌘V does: a paste event carrying the clipboard text */
const pasteText = (h: Host, text: string) =>
  h.page.evaluate((t) => {
    const dt = new DataTransfer();
    dt.setData("text/plain", t);
    window.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true }));
  }, text);
const cardEl = (h: Host, title: string) =>
  h.page.locator(".card", {
    has: h.page.locator(".chead .ctitle", { hasText: new RegExp(`^${title.replace(/\./g, "\\.")}$`) }),
  });
/** Both boards have settled (the host relays changes from one to the other) */
const both = async (a: Host, m: Host) => {
  await idle(a);
  await idle(m);
};

test("sharedcards", async () => {
  // Attention: step → schedule (call mark A); a sidenote on line start+3 of schedule (the harness diff edits that line)
  const A = emptyBoard("bA", "Attention");
  const step = symCard(findSym("LLMEngine.step").f, findSym("LLMEngine.step").s),
    sch = symCard(findSym("Scheduler.schedule").f, findSym("Scheduler.schedule").s);
  put(A, step, 60, 60);
  put(A, sch, 700, 60);
  const s0 = sch.segments[0],
    line = s0.text.findIndex((t) => /self\.schedule\(\)/.test(t));
  const callLine =
    step.segments[0].start +
    Math.max(
      0,
      step.segments[0].text.findIndex((t) => /schedule\(\)/.test(t)),
    );
  A.links.push({
    id: "l1",
    from: { card: step.id, seg: step.segments[0].id, line: callLine },
    to: { card: sch.id },
    call: { name: "schedule", col: 0 },
  });
  s0.hl = [[s0.start + 3, s0.start + 3]];
  A.sidenotes.push({
    id: "sn1",
    kind: "text",
    md: "Prefill first, then decode.",
    at: { card: sch.id, seg: s0.id, lines: [s0.start + 3, s0.start + 3] },
  });
  const M = emptyBoard("bM", "MoE");
  const post = symCard(findSym("Scheduler.postprocess").f, findSym("Scheduler.postprocess").s);
  put(M, post, 60, 60);
  void line;
  const t = await sharedHost([A, M]);
  const a = t.hosts.get("bA")!,
    m = t.hosts.get("bM")!;
  const res: Record<string, unknown> = {};

  // 1. ⌘C on Attention, ⌘V on MoE → linked card (same id, shared in the library)
  await cardEl(a, "Scheduler.schedule")
    .locator(".chead")
    .click({ position: { x: 80, y: 10 } });
  await a.page.keyboard.press("Meta+c");
  await until(a, "⌘C puts the card on the host's clipboard", () => t.clip());
  await m.page.mouse.move(700, 120);
  await pasteText(m, t.clip()!.text);
  await until(
    m,
    "the pasted card is linked on MoE",
    () => t.store.peek("bM")!.cards.some((c) => c.id === sch.id) && t.store.refsOf("bM").has(sch.id),
  );
  // "⧉ 2 boards" comes with the host's sharedInfo push (debounced after the save): not a board message idle() could see
  await cardEl(a, "Scheduler.schedule").locator(".chead .shb").waitFor();
  await cardEl(m, "Scheduler.schedule").locator(".chead .shb").waitFor();
  await both(a, m);
  res.pasted = t.store.peek("bM")!.cards.some((c) => c.id === sch.id) && t.store.refsOf("bM").has(sch.id);
  res.travelled = t.store.peek("bM")!.sidenotes.some((n) => n.id === "sn1");
  res.badgeA = await cardEl(a, "Scheduler.schedule").locator(".chead .shb").textContent();
  res.badgeM = await cardEl(m, "Scheduler.schedule").locator(".chead .shb").textContent();
  // ← N on MoE counts the arrow on Attention
  res.linkedM = await cardEl(m, "Scheduler.schedule").locator(".chead .linkedin").textContent();

  // 2. Badge → board list (with each board's mark); pick Attention → that board reveals the card
  await cardEl(m, "Scheduler.schedule").locator(".chead .shb").click();
  await m.page.locator(".pop.k-boards .cand").first().waitFor();
  await idle(m);
  res.list = await m.page.locator(".pop.k-boards .cand").allTextContents();
  await shot(m, "shared-1-badge-boards");
  await m.page.locator(".pop.k-boards .cand", { hasText: "Attention" }).click();
  await until(m, "the pick asks the host to open Attention", () => t.opened.length);
  await a.page.locator(".card.sel .ctitle").first().waitFor();
  await both(a, m); // the host's reveal on Attention
  res.opened = t.opened.at(-1);
  res.revealedA = await a.page.locator(".card.sel .ctitle").first().textContent();

  // 3. ← N: the remote arrow is listed and opens Attention
  await cardEl(m, "Scheduler.schedule").locator(".chead .linkedin").click();
  await m.page.locator(".pop.k-pick .cand").first().waitFor();
  await idle(m);
  res.linkedList = await m.page.locator(".pop.k-pick .cand").allTextContents();
  await m.page.keyboard.press("Escape");

  // 4. A sidenote edited on MoE shows on Attention (one copy of the sidenote)
  await cardEl(m, "Scheduler.schedule")
    .locator(".chead")
    .click({ position: { x: 80, y: 10 } });
  await m.page.keyboard.press("s");
  await m.page.locator(".pop button", { hasText: /^Text$/ }).click();
  await m.page.locator(".pop :focus").waitFor();
  await m.page.keyboard.type("Added on MoE.");
  await m.page.locator(".pop button", { hasText: /^Add$/ }).click();
  await until(m, "the sidenote is saved on MoE", () =>
    t.store.peek("bM")!.sidenotes.some((n) => n.kind === "text" && n.md === "Added on MoE."),
  );
  await cardEl(a, "Scheduler.schedule").locator(".chead .mk").waitFor();
  await both(a, m); // relayed to Attention
  res.noteOnA = (await t.store.load("bA"))!.sidenotes.some((n) => n.kind === "text" && n.md === "Added on MoE.");
  res.noteOnAPage = await cardEl(a, "Scheduler.schedule").locator(".chead .mk").textContent();

  // 5. Board-only from the sidenote's context menu: it leaves Attention
  await cardEl(m, "Scheduler.schedule").locator(".chead .mk").click();
  await m.page.locator(".pop.k-notes .sn-item").first().click({ button: "right" });
  await m.page.locator(".ctx:not(.closing) button").first().waitFor();
  await idle(m);
  res.noteMenu = await m.page.locator(".ctx:not(.closing) button").allTextContents();
  await shot(m, "shared-2-sidenote-menu");
  await m.page.locator(".ctx:not(.closing) button", { hasText: "Board-only" }).click();
  await until(m, "the sidenote is made board-only on MoE", () =>
    t.store.peek("bM")!.sidenotes.some((n) => n.kind === "text" && n.md === "Added on MoE." && n.boardOnly),
  );
  await until(
    a,
    "Attention's saved board drops the board-only sidenote",
    async () => !(await t.store.load("bA"))!.sidenotes.some((n) => n.kind === "text" && n.md === "Added on MoE."),
  );
  await both(a, m);
  res.boardOnly =
    !(await t.store.load("bA"))!.sidenotes.some((n) => n.kind === "text" && n.md === "Added on MoE.") &&
    t.store.peek("bM")!.sidenotes.some((n) => n.kind === "text" && n.md === "Added on MoE." && n.boardOnly);
  await m.page.keyboard.press("Escape");
  await m.page.keyboard.press("Escape");

  // 6. Update on a shared card asks for the scope first; Update on All Boards moves Attention's arrow too and marks the sidenote for review
  await m.post({ type: "stale", stale: { [s0.id]: { state: "changed", hiddenOnly: false, head: "f64d8210" } } } as any);
  await cardEl(m, "Scheduler.schedule").locator(".chead .rev.new").click();
  await m.page.locator(".diffpop .db button.def").click(); // the diff comes with the host's reply
  await m.page.locator(".dialog").waitFor();
  await idle(m);
  res.dialog = await m.page.locator(".dialog").textContent();
  await shot(m, "shared-3-update-scope");
  await m.page.locator(".dialog button", { hasText: "Update on All Boards" }).click();
  await until(
    m,
    "Update on All Boards updates the card on Attention",
    () => (t.store.peek("bA")!.cards.find((c) => c.id === sch.id) as any)?.segments[0].version.commit === "f64d8210",
  );
  await until(a, "Attention shows the review marker", () =>
    cardEl(a, "Scheduler.schedule").locator(".hxm.rv, .chead .rvdot").count(),
  );
  await both(a, m);
  const sa = (t.store.peek("bA")!.cards.find((c) => c.id === sch.id) as any).segments[0];
  res.updatedA = sa.version.commit === "f64d8210";
  res.reviewA = (await t.store.load("bA"))!.sidenotes.find((n) => n.id === "sn1")?.review;
  res.amberA = await cardEl(a, "Scheduler.schedule").locator(".hxm.rv, .chead .rvdot").count();
  await shot(a, "shared-4-review-marker");

  // 7. Card menu on a shared card: Remove from This Board / Delete Everywhere… / Unlink
  await cardEl(m, "Scheduler.schedule")
    .locator(".chead")
    .click({ button: "right", position: { x: 80, y: 10 } });
  await m.page.locator(".ctx:not(.closing) button").first().waitFor();
  await idle(m);
  res.menu = await m.page.locator(".ctx:not(.closing) .mh, .ctx:not(.closing) button").allTextContents();
  await shot(m, "shared-5-delete-menu");
  await m.page.keyboard.press("Escape");

  // 8. ⌫ removes from MoE only (Attention keeps it, badge goes away); ⌘Z brings it back linked
  await cardEl(m, "Scheduler.schedule")
    .locator(".chead")
    .click({ position: { x: 80, y: 10 } });
  await m.page.keyboard.press("Backspace");
  await until(m, "⌫ removes the card from MoE", () => !t.store.peek("bM")!.cards.some((c) => c.id === sch.id));
  await expect(cardEl(a, "Scheduler.schedule").locator(".chead .shb")).toHaveCount(0);
  await both(a, m); // the host's sharedInfo push
  res.removed =
    !t.store.peek("bM")!.cards.some((c) => c.id === sch.id) && t.store.peek("bA")!.cards.some((c) => c.id === sch.id);
  res.badgeGone = await cardEl(a, "Scheduler.schedule").locator(".chead .shb").count();
  await m.page.keyboard.press("Meta+z");
  await until(m, "⌘Z links the card on MoE again", () => t.store.refsOf("bM").has(sch.id));
  await expect(cardEl(a, "Scheduler.schedule").locator(".chead .shb")).toHaveCount(1);
  await both(a, m);
  res.back =
    t.store.refsOf("bM").has(sch.id) && (await cardEl(a, "Scheduler.schedule").locator(".chead .shb").count()) === 1;

  // 9. ⌥⌘V: an independent copy (new id, not in the library)
  await m.page.mouse.move(300, 600);
  await m.page.keyboard.press("Meta+Alt+v");
  await until(m, "⌥⌘V pastes a copy", () => t.store.peek("bM")!.cards.length === 3);
  await idle(m);
  const ids = t.store.peek("bM")!.cards.map((c) => c.id);
  res.copy =
    ids.length === 3 && ids.filter((x) => x !== sch.id && x !== post.id).every((x) => !t.store.refsOf("bM").has(x));

  // 10. ⌘⌫ Delete Everywhere (confirm) removes it from both boards and from the library
  await m.page.keyboard.press("Escape");
  await m.page.keyboard.press("Shift+Digit1");
  await idle(m);
  await m.page
    .locator(".card", { has: m.page.locator(".chead .shb") })
    .locator(".chead")
    .click({ position: { x: 80, y: 10 } });
  await m.page.keyboard.press("Meta+Backspace");
  await m.page.locator(".dialog .dt").waitFor();
  res.confirm = await m.page.locator(".dialog .dt").textContent();
  await m.page.locator(".dialog button", { hasText: "Delete Everywhere" }).click();
  await until(
    m,
    "Delete Everywhere removes the card from MoE",
    () => !t.store.peek("bM")!.cards.some((c) => c.id === sch.id),
  );
  await expect(cardEl(a, "Scheduler.schedule")).toHaveCount(0);
  await both(a, m); // the host's sharedGone push
  res.everywhere =
    !t.store.peek("bA")!.cards.some((c) => c.id === sch.id) &&
    !t.store.peek("bM")!.cards.some((c) => c.id === sch.id) &&
    !fs.existsSync(path.join(t.dir, "cards", `${sch.id}.json`));
  res.pageA = await cardEl(a, "Scheduler.schedule").count();

  const ok =
    res.pasted &&
    res.travelled &&
    /2 boards/.test(String(res.badgeA)) &&
    /2 boards/.test(String(res.badgeM)) &&
    /← 1/.test(String(res.linkedM)) &&
    (res.list as string[]).length === 2 &&
    /Attention.*A.*This board|Attention.*A.*Open/.test((res.list as string[]).join("|")) &&
    (res.opened as any)?.id === "bA" &&
    res.revealedA === "Scheduler.schedule" &&
    (res.linkedList as string[]).some((x) => /Attention/.test(x)) &&
    res.noteOnA &&
    res.boardOnly &&
    /on 2 boards: Attention, MoE/.test(String(res.dialog)) &&
    /sidenote/.test(String(res.dialog)) &&
    res.updatedA &&
    res.reviewA === "f64d821" &&
    (res.amberA as number) > 0 &&
    (res.menu as string[]).some((x) => /on 2 boards/.test(x)) &&
    (res.menu as string[]).some((x) => /Remove from This Board/.test(x)) &&
    (res.menu as string[]).some((x) => /Delete Everywhere/.test(x)) &&
    res.removed &&
    res.badgeGone === 0 &&
    res.back &&
    res.copy &&
    /everywhere/i.test(String(res.confirm)) &&
    res.everywhere &&
    res.pageA === 0;
  check("sharedcards", ok, JSON.stringify(res));
  await t.close();
});

test("sharedHighlightBoardOnly", async () => {
  const A = emptyBoard("bA", "Attention");
  const sch = symCard(findSym("Scheduler.schedule").f, findSym("Scheduler.schedule").s);
  put(A, sch, 60, 60, 620);
  const s0 = sch.segments[0],
    L = s0.start;
  s0.hl = [[L + 3, L + 5]];
  A.sidenotes.push({
    id: "sn1",
    kind: "text",
    md: "Shared note.",
    at: { card: sch.id, seg: s0.id, lines: [L + 3, L + 5] },
  });
  const M = emptyBoard("bM", "MoE");
  const t = await sharedHost([A, M]);
  const a = t.hosts.get("bA")!,
    m = t.hosts.get("bM")!;
  const res: Record<string, unknown> = {};
  const segOn = (id: string) => (t.store.peek(id)!.cards.find((c) => c.id === sch.id) as CodeCard).segments[0];
  const no = (h: Host, line: number) =>
    cardEl(h, "Scheduler.schedule").locator(".gutter .no", { hasText: new RegExp(`^${line}$`) });
  const marker = (h: Host, a0: number, z: number) =>
    cardEl(h, "Scheduler.schedule").locator(`.hxm[data-hl$=":${s0.id}:${a0}-${z}"]`);

  // the card on MoE, linked
  await cardEl(a, "Scheduler.schedule")
    .locator(".chead")
    .click({ position: { x: 80, y: 10 } });
  await a.page.keyboard.press("Meta+c");
  await until(a, "⌘C puts the card on the host's clipboard", () => t.clip());
  await m.page.mouse.move(600, 120);
  await pasteText(m, t.clip()!.text);
  await until(m, "the pasted card is linked on MoE", () => t.store.refsOf("bM").has(sch.id));
  await cardEl(m, "Scheduler.schedule").locator(".chead .shb").waitFor();
  await both(a, m);

  // MoE: a note on lines L+6..L+9, made board-only from its Highlight's popup
  await no(m, L + 6).click();
  await no(m, L + 9).click({ modifiers: ["Shift"] });
  await m.page.keyboard.press("s");
  await m.page.locator(".pop button", { hasText: /^Text$/ }).click();
  await m.page.locator(".pop :focus").waitFor();
  await m.page.keyboard.type("Only on MoE.");
  await m.page.locator(".pop button", { hasText: /^Add$/ }).click();
  await until(m, "the note is saved on MoE", () =>
    t.store.peek("bM")!.sidenotes.some((n) => n.kind === "text" && n.md === "Only on MoE."),
  );
  await m.page.keyboard.press("Escape");
  await marker(m, L + 6, L + 9).click();
  await m.page.locator('.pop.k-highlight .slip button[aria-label="Board-only"]').click();
  await until(m, "the note is board-only", () =>
    t.store.peek("bM")!.sidenotes.some((n) => n.kind === "text" && n.md === "Only on MoE." && n.boardOnly),
  );
  await m.page.keyboard.press("Escape");
  await until(a, "Attention no longer has MoE's Highlight", () => segOn("bA").hl?.length === 1);
  await both(a, m);
  res.madeLocal = {
    sharedA: segOn("bA").hl,
    sharedM: segOn("bM").hl,
    markersA: await cardEl(a, "Scheduler.schedule").locator(".hxm").count(),
    markerM: await marker(m, L + 6, L + 9).textContent(),
  };

  // Attention removes the shared Highlight, with its note
  await no(a, L + 4).hover();
  await a.page.locator(".pop.k-highlight").waitFor();
  await a.page.locator('.pop.k-highlight [aria-label="Remove Highlight"]').click();
  await until(
    m,
    "MoE gets the removal",
    () => !segOn("bM").hl && !t.store.peek("bM")!.sidenotes.some((n) => n.id === "sn1"),
  );
  await both(a, m);
  const mine = () => t.store.peek("bM")!.sidenotes.find((n) => n.kind === "text" && n.md === "Only on MoE.");
  res.removed = {
    note: mine()?.at.lines,
    marker: await marker(m, L + 6, L + 9).count(),
    dangling: danglingRefs(t.store.peek("bM")!),
  };

  // Attention highlights lines L+5..L+7, across MoE's: MoE shows one Highlight of both, its note on it
  await no(a, L + 5).click();
  await no(a, L + 7).click({ modifiers: ["Shift"] });
  await no(a, L + 7).click({ button: "right" });
  await a.page.locator(".ctx:not(.closing) button", { hasText: "Highlight Lines" }).click();
  await until(m, "MoE gets the new Highlight", () => segOn("bM").hl?.length === 1);
  await both(a, m);
  const bm = t.store.peek("bM")!;
  res.grown = {
    shared: segOn("bM").hl,
    shown: shownRanges(bm, segOn("bM")),
    note: mine()?.at.lines,
    marker: await marker(m, L + 5, L + 9).textContent(),
    dangling: danglingRefs(bm),
  };
  const r = res as {
    madeLocal: { sharedA: unknown; sharedM: unknown; markersA: number; markerM: string | null };
    removed: { note: unknown; marker: number; dangling: string[] };
    grown: { shared: unknown; shown: unknown; note: unknown; marker: string | null; dangling: string[] };
  };
  check(
    "sharedHighlightBoardOnly made board-only, the note takes its Highlight off the shared card",
    JSON.stringify(r.madeLocal.sharedA) === JSON.stringify([[L + 3, L + 5]]) &&
      JSON.stringify(r.madeLocal.sharedM) === JSON.stringify([[L + 3, L + 5]]) &&
      r.madeLocal.markersA === 1 &&
      r.madeLocal.markerM === "1",
    r.madeLocal,
  );
  check(
    "sharedHighlightBoardOnly the other board removing the shared Highlight leaves the board-only note and its Highlight",
    JSON.stringify(r.removed.note) === JSON.stringify([L + 6, L + 9]) &&
      r.removed.marker === 1 &&
      !r.removed.dangling.length,
    r.removed,
  );
  check(
    "sharedHighlightBoardOnly a shared Highlight grown across it shows as one with the note on it",
    JSON.stringify(r.grown.shared) === JSON.stringify([[L + 5, L + 7]]) &&
      JSON.stringify(r.grown.shown) === JSON.stringify([[L + 5, L + 9]]) &&
      JSON.stringify(r.grown.note) === JSON.stringify([L + 6, L + 9]) &&
      r.grown.marker === "1" &&
      !r.grown.dangling.length,
    r.grown,
  );
  await t.close();
});
