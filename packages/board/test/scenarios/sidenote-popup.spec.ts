// The sidenote popup (ui/pops/notes.tsx) and its input (ui/NoteComposer.tsx):
//  sidenoteRefInsert       S on selected lines opens their popup with the input focused; `[[` in it lists the board's cards, the
//                          highlighted one previewed beside the list; ↵ inserts the reference, ↵ again adds the sidenote with it
//  sidenoteRefPreview      a click on a [[reference]] in a sidenote to a card far from the view shows the card's beginning beside
//                          the popup (resting on it shows nothing); a second click, Esc or a click elsewhere closes it, the popup
//                          staying; its arrow goes to the card
//  sidenoteRefNear         a click on a [[reference]] in a sidenote to a card in view selects the card, with no preview
//  sidenoteAddFromPlus     the + at the bottom turns into the input: ↵ adds and keeps a clear, focused input, ⇧↵ breaks the line,
//                          Esc empty gives the + back; what is written is added by a click elsewhere and by Close
//  sidenoteOpenNoFlash     a click on a Highlight's count opens its popup, which stays when the pointer leaves; a second click
//                          closes it, nothing else on the board flashing
//  sidenoteCodeCap         a Code sidenote longer than 8 lines is cut there; a click shows it all, another cuts it again
//  sidenoteCodeFitsSlip    a Code sidenote with a long name, path and line stays inside its slip: the line scrolls in the code,
//                          the name and path are cut with an ellipsis, the version stays whole at the right; its head starts
//                          where a Text sidenote's text does
//  sidenotePopupDrag       the popup follows its card as the board pans; dragged by its title bar it stays where it was put in the
//                          window as the board pans and zooms; closed and opened again it is back beside the card
//  sidenoteWholeCardPopup  the card menu's first item, Add Sidenote, opens the card's popup right of it with the input focused;
//                          ↵ adds a whole-card sidenote; the badge past the card's edge opens the popup, and its Delete removes
//                          the card's sidenotes
//  sidenoteAddBesideCount  selected lines ending on a Highlight's count: their + sits under the count, both visible and
//                          clickable (the + opens the lines' popup with the input, the count its Highlight's popup); under the
//                          count, or left of the number between counts, at 100% and zoomed out, it stays clear of the counts and
//                          of the handles on the card's left edge
//  sidenoteStateIcons      a sidenote's state (its line removed) shows as an icon whose tooltip says it, with no words in the slip
import type { Page } from "@playwright/test";
import { emptyBoard, type Board, type CodeCard } from "@codeboard/core";
import { put, shot, type Host } from "../harness";
import { TIP_DELAY } from "../../src/state/timing";
import { test, open, check, light, expect, until, idle, hold } from "../fixtures";
import { watch } from "../watch";

const CODE = Array.from({ length: 24 }, (_, i) =>
  i % 4 === 0 ? `def step_${i}(seq):` : `    total += seq.len * ${i}`,
);
const LONG = Array.from({ length: 14 }, (_, i) => `x${i} = blocks[${i}] + 1`);

function board(): Board {
  const b = emptyBoard("b1", "sidenote popup");
  const seg = {
    id: "s1",
    src: { kind: "free" },
    path: "",
    lang: "python",
    start: 1,
    end: CODE.length,
    text: CODE.slice(),
    version: { kind: "none" },
    hl: [[3, 4]],
  };
  put(b, { id: "k1", kind: "code", title: "schedule", segments: [seg] } as unknown as CodeCard, 60, 60, 460);
  put(
    b,
    { id: "nc", kind: "note", look: "note", md: "## Block Manager\n\nHands out KV cache blocks." } as never,
    60,
    640,
    320,
  );
  const at = { card: "k1", seg: "s1", lines: [3, 4] as [number, number] };
  b.sidenotes.push(
    { id: "t1", kind: "text", md: "Blocks come from [[Block Manager#^nc]].", at },
    {
      id: "c1",
      kind: "code",
      at,
      code: {
        id: "s2",
        src: { kind: "free" },
        path: "",
        lang: "python",
        start: 1,
        end: LONG.length,
        text: LONG.slice(),
        version: { kind: "none" },
      },
    },
  );
  b.cam = { x: 0, y: 0, z: 1 };
  return b;
}

const POP = ".pop.k-highlight";
const no = (pg: Page, line: number) =>
  pg.locator('.card[data-id="k1"] .gutter .no', { hasText: new RegExp(`^${line}$`) });
const marker = (pg: Page) => pg.locator('.card[data-id="k1"] .hxm[data-hl="k1:s1:3-4"]');
const typing = (pg: Page, pop = POP) => pg.locator(`${pop} .ncomp .md-pm:focus`);
const texts = (h: Host) => h.board().sidenotes.map((n) => (n.kind === "text" ? n.md : n.kind));
const rect = (pg: Page, sel: string) =>
  pg.locator(sel).evaluate((e) => {
    const r = e.getBoundingClientRect();
    return { x: Math.round(r.left), y: Math.round(r.top), r: Math.round(r.right), b: Math.round(r.bottom) };
  });
/** Opens the 3–4 Highlight's popup, pinned */
async function openPinned(h: Host) {
  // a click on the count toggles its popup: only when it is not open already
  if (!(await h.page.locator(POP).count())) await marker(h.page).click();
  await h.page.locator(POP).waitFor();
  await idle(h);
}

test("sidenoteRefInsert", async () => {
  // wide enough for the preview on the list's right (the side it always takes)
  const h = await open({ board: board(), light, w: 1400, h: 900 });
  const pg = h.page;
  await idle(h);
  await no(pg, 8).click();
  await no(pg, 9).click({ modifiers: ["Shift"] });
  await pg.keyboard.press("s");
  await typing(pg).waitFor();
  await pg.keyboard.type("See [[Block");
  await pg.locator(".md-pick").waitFor();
  await pg.locator(".cpeek.passive.show").waitFor();
  await idle(h);
  const listed = await pg.evaluate(() => {
    const pk = document.querySelector<HTMLElement>(".cpeek")!.getBoundingClientRect(),
      list = document.querySelector<HTMLElement>(".md-pick")!.getBoundingClientRect();
    return {
      text: document.querySelector(".cpeek")?.textContent ?? "",
      beside: pk.left >= list.right - 1 || pk.right <= list.left + 1,
      go: document.querySelectorAll(".cpeek .cpeek-go").length,
    };
  });
  await pg.keyboard.press("Enter");
  await expect(pg.locator(".md-pick")).toHaveCount(0);
  await expect(pg.locator(".cpeek")).toHaveCount(0);
  const before = h.board().sidenotes.length;
  await pg.keyboard.press("Enter");
  await until(h, "the sidenote is added", () => h.board().sidenotes.length > before);
  const n = h.board().sidenotes.at(-1)!;
  check(
    "sidenoteRefInsert the [[ list shows the highlighted card beside it, and ↵ inserts the reference the added sidenote keeps",
    listed.text.includes("Hands out KV cache blocks") &&
      listed.beside &&
      listed.go === 0 &&
      n.kind === "text" &&
      /^See \[\[[^\]]*#\^nc\]\]\s*$/.test(n.md) &&
      JSON.stringify(n.at.lines) === "[8,9]",
    { listed, n },
  );
  await h.close();
});

test("sidenoteRefNear", async () => {
  const h = await open({ board: board(), light, w: 1300, h: 900 });
  const pg = h.page;
  await idle(h);
  await openPinned(h);
  await pg.locator(`${POP} .slip .md-ref`).first().click();
  await pg.locator('.card.sel[data-id="nc"]').waitFor();
  await idle(h);
  const peeks = await pg.locator(".cpeek").count();
  check("sidenoteRefNear a reference to a card in view selects it, no preview", peeks === 0, { peeks });
  await h.close();
});

test("sidenoteRefPreview", async () => {
  // wide enough for the preview on the popup's right (the side it always takes); the card far from the view, so a click on a
  // reference to it previews it (one near the view is gone to)
  const b = board();
  b.place.nc.x = 3000;
  // a sidenote on the previewed card: its badge is copied into the preview, where nothing looking for badges may find it
  b.sidenotes.push({ id: "t-nc", kind: "text", md: "on the card", at: { card: "nc" } } as never);
  const h = await open({ board: b, light, w: 1400, h: 900 });
  const pg = h.page;
  await idle(h);
  await openPinned(h);
  const ref = pg.locator(`${POP} .slip .md-ref`).first();
  const peeks = () => pg.locator(".cpeek").count();
  await ref.hover();
  await hold(h, TIP_DELAY * 2, "resting on a reference must not preview its card");
  const onHover = await peeks();
  await ref.click();
  await pg.locator(".cpeek.show").waitFor();
  await idle(h);
  const shown = await pg.evaluate((sel) => {
    const pk = document.querySelector<HTMLElement>(".cpeek")!,
      r = pk.getBoundingClientRect(),
      pop = document.querySelector<HTMLElement>(sel)!.getBoundingClientRect();
    return {
      text: pk.textContent ?? "",
      beside: r.left >= pop.right - 1 || r.right <= pop.left + 1,
      h: Math.round(r.height),
      // a copy of the card, which nothing looking for the board's cards finds
      copy: !!pk.querySelector(".card") && !pk.querySelector("[data-id], [data-spot]"),
      badges: pk.querySelectorAll(".snb").length,
      go: pk.querySelectorAll(".cpeek-go").length,
    };
  }, POP);
  await ref.click();
  await until(h, "a second click closes the preview", async () => (await peeks()) === 0);
  await ref.click();
  await pg.locator(".cpeek.show").waitFor();
  await pg.keyboard.press("Escape");
  await until(h, "Esc closes the preview", async () => (await peeks()) === 0);
  const popAfterEsc = await pg.locator(POP).count();
  await ref.click();
  await pg.locator(".cpeek.show").waitFor();
  // an empty spot of the board (at the bottom right the zoom bar's Fit to Window would bring the card into view)
  await pg.mouse.click(1250, 700);
  await until(h, "a click elsewhere closes the preview", async () => (await peeks()) === 0);
  await openPinned(h);
  await pg.locator(`${POP} .slip .md-ref`).first().click();
  await pg.locator(".cpeek.show .cpeek-go").click();
  await pg.locator('.card.sel[data-id="nc"]').waitFor();
  const afterGo = await peeks();
  check(
    "sidenoteRefPreview a click on a reference previews its card beside the popup; a click, Esc or a click elsewhere closes it",
    onHover === 0 &&
      shown.text.includes("Hands out KV cache blocks") &&
      shown.beside &&
      shown.copy &&
      shown.badges > 0 &&
      shown.go === 1 &&
      shown.h <= 290 &&
      popAfterEsc === 1 &&
      afterGo === 0,
    { onHover, shown, popAfterEsc, afterGo },
  );
  await h.close();
});

test("sidenoteAddFromPlus", async () => {
  const h = await open({ board: board(), light, w: 1300, h: 900 });
  const pg = h.page;
  await idle(h);
  await openPinned(h);
  await pg.locator(`${POP} button.add`).click();
  await typing(pg).waitFor();
  await pg.keyboard.type("first");
  await pg.keyboard.press("Enter");
  await until(h, "↵ adds the sidenote", () => texts(h).includes("first"));
  await typing(pg).waitFor();
  await idle(h);
  const kept = await pg.evaluate((sel) => {
    const pop = document.querySelector(sel)!;
    const slips = [...pop.querySelectorAll(".slip")];
    return {
      empty: (pop.querySelector(".ncomp .md-pm")?.textContent ?? "x").trim() === "",
      last: slips.at(-1)?.textContent?.includes("first") ?? false,
      slips: slips.length,
    };
  }, POP);
  await pg.keyboard.type("second");
  await pg.keyboard.press("Shift+Enter");
  await pg.keyboard.type("line two");
  await pg.keyboard.press("Enter");
  await until(h, "↵ adds the two-line sidenote", () => texts(h).some((t) => t.startsWith("second")));
  await typing(pg).waitFor();
  await pg.keyboard.press("Escape");
  await pg.locator(`${POP} button.add`).waitFor();
  const plusBack = await pg.locator(POP).count();
  await pg.locator(`${POP} button.add`).click();
  await typing(pg).waitFor();
  await pg.keyboard.type("third");
  await pg.mouse.click(1250, 860);
  await until(h, "a click elsewhere adds what is written", () => texts(h).includes("third"));
  await idle(h);
  if (!(await pg.locator(POP).count())) await openPinned(h);
  await pg.locator(`${POP} button.add`).click();
  await typing(pg).waitFor();
  await pg.keyboard.type("fourth");
  await pg.locator(`${POP} .hh button[aria-label="Close"]`).click();
  await until(h, "Close adds what is written", () => texts(h).includes("fourth"));
  await expect(pg.locator(POP)).toHaveCount(0);
  const two = texts(h).find((t) => t.startsWith("second")) ?? "";
  const lines = h.board().sidenotes.filter((n) => n.kind === "text" && JSON.stringify(n.at.lines) === "[3,4]").length;
  check(
    "sidenoteAddFromPlus ↵ adds in place and keeps an empty focused input; ⇧↵ breaks the line; Esc, a click elsewhere, Close",
    kept.empty &&
      kept.last &&
      kept.slips === 3 &&
      /^second(<br>|\s*\\?\n)\s*line two$/.test(two) &&
      plusBack === 1 &&
      lines === 5,
    { kept, two, plusBack, lines, texts: texts(h) },
  );
  await h.close();
});

test("sidenoteOpenNoFlash", async () => {
  const h = await open({ board: board(), light, w: 1300, h: 900 });
  const pg = h.page;
  await idle(h);
  await marker(pg).click();
  await pg.locator(POP).waitFor();
  await idle(h);
  const id = await pg.locator(POP).getAttribute("data-pop");
  await pg.mouse.move(1250, 860);
  await hold(h, TIP_DELAY * 2, "a popup a click opened stays after the pointer leaves");
  const kept = (await pg.locator(POP).getAttribute("data-pop")) === id && (await pg.locator(POP).count()) === 1;
  // a second click closes it, with nothing else on the board flashing or moving
  await watch(h, "sidenoteOpenNoFlash", { keep: ['.card[data-id="k1"]'], ignore: [POP], frames: 14 }, () =>
    marker(pg).click(),
  );
  check(
    "sidenoteOpenNoFlash a click on the count opens the popup, which stays when the pointer leaves; another click closes it",
    kept && (await pg.locator(POP).count()) === 0,
    { id, kept },
  );
  await h.close();
});

test("sidenoteCodeCap", async () => {
  const h = await open({ board: board(), light, w: 1300, h: 900 });
  const pg = h.page;
  await idle(h);
  await openPinned(h);
  const code = pg.locator(`${POP} .sn-code`);
  const read = () =>
    code.evaluate((e) => {
      const pre = e.querySelector<HTMLElement>(".pcode")!;
      return { cut: e.classList.contains("cut"), h: pre.clientHeight, full: pre.scrollHeight };
    });
  const cut = await read();
  await code.click();
  await idle(h);
  const opened = await read();
  await code.click();
  await idle(h);
  const again = await read();
  check(
    "sidenoteCodeCap 14 lines are cut at 8; a click shows them all, another cuts them again",
    cut.cut &&
      cut.h < cut.full &&
      cut.h <= 8 * 20 + 6 &&
      !opened.cut &&
      opened.h >= opened.full - 1 &&
      again.cut &&
      again.h === cut.h,
    { cut, opened, again },
  );
  await h.close();
});

test("sidenoteCodeFitsSlip", async () => {
  const b = board();
  const c1 = b.sidenotes.find((n) => n.id === "c1")!;
  if (c1.kind !== "code") throw new Error("c1 is a Code sidenote");
  c1.code = {
    ...c1.code,
    src: { kind: "repo", repo: "" },
    path: "nanovllm/engine/a_rather_long_module_name_for_the_block_manager.py",
    symbol: { qual: "BlockManagerWithAVeryLongName.allocate_blocks_for_sequence", kind: "function" },
    version: { kind: "git", commit: "bb823b3c0ffee" },
    text: [
      "def allocate_blocks_for_sequence(self, seq: Sequence, num_cached_blocks: int, prefix_hash: int, *, strict: bool = True):",
      ...LONG.slice(1),
    ],
  };
  const h = await open({ board: b, light, w: 1300, h: 900 });
  const pg = h.page;
  await idle(h);
  await openPinned(h);
  const fit = await pg.evaluate((sel) => {
    const slips = [...document.querySelectorAll<HTMLElement>(`${sel} .slip`)];
    const code = slips.find((e) => e.querySelector(".sn-code"))!,
      text = slips.find((e) => e.querySelector(".sb.nbody"))!;
    const box = code.getBoundingClientRect();
    // what lies inside the code's own scroll box is in view only as far as that box shows it
    const over = [...code.querySelectorAll<HTMLElement>("*")]
      .filter((e) => !e.closest(".pcode") || e.classList.contains("pcode"))
      .filter((e) => e.getBoundingClientRect().right > box.right + 0.5)
      .map((e) => e.className || e.tagName);
    const pre = code.querySelector<HTMLElement>(".pcode")!,
      head = code.querySelector<HTMLElement>(".sn-head")!,
      name = head.querySelector<HTMLElement>("b")!,
      rev = head.querySelector<HTMLElement>(".rev")!;
    // where the words start: the head's name and the text's first block
    const r = rev.getBoundingClientRect(),
      hr = name.getBoundingClientRect(),
      tb = text.querySelector<HTMLElement>(".sb.nbody > *")!.getBoundingClientRect(),
      tr = text.getBoundingClientRect();
    return {
      over,
      scrolls: pre.scrollWidth > pre.clientWidth,
      cut: name.scrollWidth > name.clientWidth && getComputedStyle(name).textOverflow === "ellipsis",
      rev: { text: rev.textContent, whole: rev.scrollWidth <= rev.clientWidth, right: box.right - r.right, w: r.width },
      left: { head: Math.round(hr.left - box.left), text: Math.round(tb.left - tr.left) },
      top: { head: Math.round(hr.top - box.top), text: Math.round(tb.top - tr.top) },
    };
  }, POP);
  check(
    "sidenoteCodeFitsSlip nothing in a Code sidenote runs past its slip; the version stays whole, the head lines up with Text ones",
    fit.over.length === 0 &&
      fit.scrolls &&
      fit.cut &&
      fit.rev.whole &&
      fit.rev.w > 20 &&
      fit.rev.right >= 0 &&
      fit.rev.right <= 12 &&
      Math.abs(fit.left.head - fit.left.text) <= 1 &&
      Math.abs(fit.top.head - fit.top.text) <= 2,
    fit,
  );
  await h.close();
});

test("sidenotePopupDrag", async () => {
  const h = await open({ board: board(), light, w: 1300, h: 900 });
  const pg = h.page;
  await idle(h);
  await openPinned(h);
  const card = () => rect(pg, '.card[data-id="k1"]');
  const pop = () => rect(pg, POP);
  const p0 = await pop(),
    c0 = await card();
  // the board pans: an undragged popup goes along with its card
  await pg.mouse.move(1000, 820);
  await pg.mouse.wheel(0, 60);
  await idle(h);
  const p1 = await pop(),
    c1 = await card();
  const followed = c1.y !== c0.y && Math.abs(p1.y - p0.y - (c1.y - c0.y)) <= 2;
  // dragged by its title bar
  const bar = (await pg.locator(`${POP} .hh .rng`).boundingBox())!;
  await pg.mouse.move(bar.x + 4, bar.y + bar.height / 2);
  await pg.mouse.down();
  for (let i = 1; i <= 8; i++) await pg.mouse.move(bar.x + 4 + i * 15, bar.y + bar.height / 2 + i * 20);
  await pg.mouse.up();
  await idle(h);
  const p2 = await pop();
  const moved = Math.abs(p2.x - p1.x - 120) <= 2 && Math.abs(p2.y - p1.y - 160) <= 2;
  // then it keeps that offset from its lines as the board pans, a dashed line back to them
  await pg.mouse.move(1000, 820);
  await pg.mouse.wheel(0, -120);
  await idle(h);
  const p3 = await pop(),
    c3 = await card();
  const line = await pg.locator(".popline").count();
  const kept =
    c3.y !== c1.y && Math.abs(p3.y - p2.y - (c3.y - c1.y)) <= 2 && Math.abs(p3.x - p2.x - (c3.x - c1.x)) <= 2;
  // closed and opened again: back beside the card
  await pg.keyboard.press("Escape");
  await expect(pg.locator(POP)).toHaveCount(0);
  await openPinned(h);
  const p4 = await pop(),
    c4 = await card();
  const back = p4.x >= c4.r && p4.x - c4.r <= 20;
  check(
    "sidenotePopupDrag the popup goes with its card; dragged, it keeps its offset from its lines with a dashed line back to them; reopened, it is beside the card",
    followed && moved && kept && line === 1 && back,
    { p0, c0, p1, c1, p2, p3, c3, line, p4, c4 },
  );
  await h.close();
});

test("sidenoteWholeCardPopup", async () => {
  const h = await open({ board: board(), light, w: 1300, h: 900 });
  const pg = h.page;
  await idle(h);
  await pg.locator('.card[data-id="k1"] .chead .ctitle').click({ button: "right" });
  await pg.locator(".ctx.open").first().waitFor();
  const items = await pg.locator(".ctx.open button .lb").allTextContents();
  await pg.locator('.ctx.open button:has(.lb:text-is("Add Sidenote"))').first().click();
  const W = ".pop.k-notes";
  await typing(pg, W).waitFor();
  await pg.keyboard.type("The whole function");
  await pg.keyboard.press("Enter");
  await until(h, "the whole-card sidenote is added", () => texts(h).includes("The whole function"));
  const n = h.board().sidenotes.find((x) => x.kind === "text" && x.md === "The whole function")!;
  await typing(pg, W).waitFor();
  await idle(h);
  const p = await rect(pg, W),
    c = await rect(pg, '.card[data-id="k1"]');
  const chrome = await pg.evaluate((sel) => {
    const pop = document.querySelector(sel)!;
    return {
      bar: [...pop.querySelectorAll(".hh button")].map((b) => b.getAttribute("aria-label")),
      slips: pop.querySelectorAll(".slip").length,
      tools: pop.querySelectorAll('.slip .kt button[aria-label="Delete Sidenote"]').length,
    };
  }, W);
  await pg.keyboard.press("Escape");
  await pg.locator(`${W} button.add`).waitFor();
  await pg.keyboard.press("Escape");
  await expect(pg.locator(W)).toHaveCount(0);
  await pg.locator('.snb[data-spot="c:k1"]').click();
  await pg.locator(W).waitFor();
  await pg.locator(`${W} .hh button`).first().click();
  await until(h, "Delete removes the card's sidenotes", () => !h.board().sidenotes.some((x) => !x.at.lines));
  await expect(pg.locator(W)).toHaveCount(0);
  check(
    "sidenoteWholeCardPopup Add Sidenote, the card menu's first item, opens the card's popup beside it, input focused; Delete and Close in its title bar",
    !n.at.lines &&
      !n.at.seg &&
      p.x >= c.r &&
      chrome.bar.join("|") === "Delete Sidenotes|Close" &&
      items[0] === "Add Sidenote" &&
      !items.includes("Sidenote") &&
      chrome.slips === 1 &&
      chrome.tools === 1 &&
      h.board().sidenotes.length === 2,
    { n, p, c, chrome, items },
  );
  await h.close();
});

test("sidenoteAddBesideCount", async () => {
  const h = await open({ board: board(), light, w: 1300, h: 900 });
  const pg = h.page;
  await idle(h);
  // lines 2–3: their last line is where the 3–4 Highlight's count is
  await no(pg, 2).click();
  await no(pg, 3).click({ modifiers: ["Shift"] });
  const plus = pg.locator('.card[data-id="k1"] .lsadd');
  await plus.waitFor();
  await idle(h);
  const geo = await pg.evaluate(() => {
    const box = (sel: string) => {
      const r = document.querySelector<HTMLElement>(sel)!.getBoundingClientRect();
      return { l: r.left, r: r.right, t: r.top, b: r.bottom };
    };
    const plus = box('.card[data-id="k1"] .lsadd'),
      count = box('.card[data-id="k1"] .hxm[data-hl="k1:s1:3-4"]'),
      num = box('.card[data-id="k1"] .gutter .no[data-r="2"]');
    const apart = (a: typeof plus, b: typeof plus) => a.r <= b.l || b.r <= a.l || a.b <= b.t || b.b <= a.t;
    const hit = (b: typeof plus, sel: string) =>
      !!document.elementFromPoint((b.l + b.r) / 2, (b.t + b.b) / 2)?.closest(sel);
    return {
      apart: apart(plus, count) && apart(plus, num),
      // just under the count, in its column
      under: plus.t >= count.b - 0.5 && plus.t - count.b <= 4 && plus.l < count.r && count.l < plus.r,
      plusHit: hit(plus, ".lsadd"),
      countHit: hit(count, ".hxm"),
    };
  });
  await shot(h, "sidenote-add-beside-count");
  await plus.click();
  await typing(pg).waitFor();
  const lines = await pg.evaluate(() => document.querySelector(".pop.k-highlight .rng")?.textContent ?? "");
  await pg.keyboard.press("Escape");
  await pg.keyboard.press("Escape");
  await expect(pg.locator(POP)).toHaveCount(0);
  await marker(pg).click();
  await pg.locator(POP).waitFor();
  const counted = await pg.evaluate(() => document.querySelector(".pop.k-highlight .rng")?.textContent ?? "");
  check(
    "sidenoteAddBesideCount the + under the count on its row: both are shown and each takes its own click",
    geo.apart && geo.under && geo.plusHit && geo.countHit && lines === "2–3" && counted === "3–4",
    { geo, lines, counted },
  );
  await h.close();
  // at the card's vertical middle, as seen and zoomed out (where a port keeps its on-screen hit area while the card shrinks): under
  // the count, or left of the number when the rows around have counts too, the + stays clear of the counts and of what sits on the
  // card's left edge there, the line's link port
  const cases = [
    { name: "middle", spot: "below", hl: [[12, 13]] as [number, number][], from: 11 },
    {
      name: "between counts",
      spot: "left",
      hl: [
        [11, 11],
        [12, 12],
        [13, 13],
      ] as [number, number][],
      from: 12,
    },
  ];
  for (const k of cases)
    for (const z of [1, 0.4]) {
      const b = board();
      const seg = (b.cards[0] as CodeCard).segments[0];
      seg.hl = [...(seg.hl ?? []), ...k.hl];
      for (const [i, lines] of k.hl.entries())
        b.sidenotes.push({ id: `m${i}`, kind: "text", md: "middle", at: { card: "k1", seg: "s1", lines } });
      b.cam = { x: 0, y: 0, z };
      const hm = await open({ board: b, light, w: 1300, h: 900 });
      const pm = hm.page;
      await idle(hm);
      await no(pm, k.from).click();
      if (k.from !== 12) await no(pm, 12).click({ modifiers: ["Shift"] });
      const plusEl = pm.locator(`.card[data-id="k1"] .lsadd.${k.spot}`);
      await plusEl.waitFor();
      // the pointer on the row's code, where its link port shows
      const pb = (await plusEl.boundingBox())!,
        cb = (await pm.locator('.card[data-id="k1"]').boundingBox())!;
      await pm.mouse.move(cb.x + cb.width / 2, pb.y + pb.height / 2);
      await idle(hm);
      const edge = await pm.evaluate(() => {
        const card = document.querySelector<HTMLElement>('.card[data-id="k1"]')!,
          cr = card.getBoundingClientRect(),
          p = card.querySelector<HTMLElement>(".lsadd")!.getBoundingClientRect();
        const mid = (cr.top + cr.bottom) / 2;
        // where a handle takes the pointer: a port's ::after, inset by --port-hit (negative: larger than the dot), scaled with it
        const hitBox = (e: HTMLElement) => {
          const r = e.getBoundingClientRect(),
            k = r.width / (e.offsetWidth || 1),
            inset = Number.parseFloat(getComputedStyle(e, "::after").inset) || 0,
            hw = (e.offsetWidth / 2 - Math.min(0, inset)) * k,
            hh = (e.offsetHeight / 2 - Math.min(0, inset)) * k,
            cx = (r.left + r.right) / 2,
            cy = (r.top + r.bottom) / 2;
          return { l: cx - hw, r: cx + hw, t: cy - hh, b: cy + hh };
        };
        const apart = (e: { l: number; r: number; t: number; b: number }) =>
          e.r <= p.left || p.right <= e.l || e.b <= p.top || p.bottom <= e.t;
        const onEdge = [...card.querySelectorAll<HTMLElement>(".lport.l, .eport.l, .hw.l, .bxh")]
          .filter((e) => getComputedStyle(e).display !== "none")
          .map((e) => ({ cls: e.className, ...hitBox(e) }));
        const counts = [...card.querySelectorAll<HTMLElement>(".hxm")].map((e) => {
          const r = e.getBoundingClientRect();
          return { l: r.left, r: r.right, t: r.top, b: r.bottom };
        });
        const top = document.elementFromPoint((p.left + p.right) / 2, (p.top + p.bottom) / 2);
        return {
          clear: onEdge.every(apart),
          countsClear: counts.every(apart),
          nearMiddle: Math.abs((p.top + p.bottom) / 2 - mid) <= cr.height / 6,
          plusOnTop: !!top?.closest(".lsadd"),
          ports: onEdge.filter((e) => e.cls.includes("lport")).length,
          plus: { l: p.left, r: p.right, t: p.top, b: p.bottom },
          onEdge,
        };
      });
      check(
        `sidenoteAddBesideCount ${k.name} at zoom ${z}: the + stays clear of the counts and the card's left edge handles`,
        edge.clear && edge.countsClear && edge.nearMiddle && edge.plusOnTop && edge.ports === 1,
        edge,
      );
      await hm.close();
    }
});

test("sidenoteStateIcons", async () => {
  const b = board();
  b.sidenotes.push({ id: "w1", kind: "text", md: "Was on a removed line", at: { card: "k1" }, lineRemoved: true });
  const h = await open({ board: b, light, w: 1300, h: 900 });
  const pg = h.page;
  await idle(h);
  await pg.locator('.snb[data-spot="c:k1"]').click();
  await pg.locator(".pop.k-notes .slip").waitFor();
  await idle(h);
  await shot(h, "sidenote-state-icons");
  const slip = await pg.evaluate(() => {
    const s = document.querySelector(".pop.k-notes .slip")!;
    const f = s.querySelector<HTMLElement>(".sn-flag");
    return {
      text: (s.textContent ?? "").trim(),
      label: f?.getAttribute("aria-label") ?? "",
      tip: f?.dataset.tip ?? "",
      warn: !!f?.classList.contains("warn"),
    };
  });
  check(
    "sidenoteStateIcons a removed line is an icon with a tooltip, no words",
    slip.text === "Was on a removed line" && /removed/i.test(slip.label) && slip.tip === slip.label && slip.warn,
    slip,
  );
  await h.close();
});
