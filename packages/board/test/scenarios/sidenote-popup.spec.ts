// The sidenote popup (ui/pops/notes.tsx) and its input (ui/NoteComposer.tsx):
//  sidenoteRefInsert       S on selected lines opens their popup with the input focused; `[[` in it lists the board's cards, the
//                          highlighted one previewed beside the list; ↵ inserts the reference, ↵ again adds the sidenote with it
//  sidenoteRefPreview      a click on a [[reference]] in a sidenote shows the card's beginning beside the popup (resting on it shows
//                          nothing); a second click, Esc or a click elsewhere closes it, the popup staying; its arrow goes to the card
//  sidenoteAddFromPlus     the + at the bottom turns into the input: ↵ adds and keeps a clear, focused input, ⇧↵ breaks the line,
//                          Esc empty gives the + back; what is written is added by a click elsewhere and by Close
//  sidenotePinNoFlash      a click on the count of a Highlight whose popup the hover opened pins that popup: it neither
//                          disappears for a frame nor fades in again
//  sidenoteCodeCap         a Code sidenote longer than 8 lines is cut there; a click shows it all, another cuts it again
//  sidenotePopupDrag       the popup follows its card as the board pans; dragged by its title bar it stays where it was put in the
//                          window as the board pans and zooms; closed and opened again it is back beside the card
//  sidenoteWholeCardPopup  the card menu's Add ▸ Sidenote opens the card's popup right of it with the input focused; ↵ adds a
//                          whole-card sidenote; the header marker pins the popup, and its Delete removes the card's sidenotes
import type { Page } from "@playwright/test";
import { emptyBoard, type Board, type CodeCard } from "@codeboard/core";
import { put, type Host } from "../harness";
import { NOTE_HOVER } from "../../src/state/timing";
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
  await marker(h.page).click();
  await h.page.locator(POP).waitFor();
  await idle(h);
}

test("sidenoteRefInsert", async () => {
  const h = await open({ board: board(), light, w: 1300, h: 900 });
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

test("sidenoteRefPreview", async () => {
  const h = await open({ board: board(), light, w: 1300, h: 900 });
  const pg = h.page;
  await idle(h);
  await openPinned(h);
  const ref = pg.locator(`${POP} .slip .md-ref`).first();
  const peeks = () => pg.locator(".cpeek").count();
  await ref.hover();
  await hold(h, NOTE_HOVER * 3, "resting on a reference must not preview its card");
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
      copy: !!pk.querySelector(".card") && !pk.querySelector("[data-id]"),
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
  await pg.mouse.click(1250, 860);
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

test("sidenotePinNoFlash", async () => {
  const h = await open({ board: board(), light, w: 1300, h: 900 });
  const pg = h.page;
  await idle(h);
  await marker(pg).hover();
  await pg.locator(POP).waitFor();
  await idle(h);
  const id = await pg.locator(POP).getAttribute("data-pop");
  await watch(h, "sidenotePinNoFlash", { keep: [POP], chrome: [POP], frames: 14 }, () => marker(pg).click());
  await pg.mouse.move(1250, 860);
  await hold(h, NOTE_HOVER * 4, "a pinned popup stays after the pointer leaves");
  check(
    "sidenotePinNoFlash pinning keeps the same popup, which stays when the pointer leaves",
    (await pg.locator(POP).getAttribute("data-pop")) === id && (await pg.locator(POP).count()) === 1,
    { id },
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
  // then pans and zooms leave it where it was put
  await pg.mouse.move(1000, 820);
  await pg.mouse.wheel(0, 120);
  await idle(h);
  await pg.keyboard.press("ControlOrMeta+Minus");
  await idle(h);
  const p3 = await pop(),
    c3 = await card();
  const fixed = p3.x === p2.x && p3.y === p2.y && (c3.y !== c1.y || c3.r !== c1.r);
  // closed and opened again: back beside the card
  await pg.keyboard.press("Escape");
  await expect(pg.locator(POP)).toHaveCount(0);
  await openPinned(h);
  const p4 = await pop(),
    c4 = await card();
  const back = p4.x >= c4.r && p4.x - c4.r <= 20;
  check(
    "sidenotePopupDrag the popup goes with its card until dragged; then it stays put in the window; reopened, it is beside the card",
    followed && moved && fixed && back,
    { p0, c0, p1, c1, p2, p3, c3, p4, c4 },
  );
  await h.close();
});

test("sidenoteWholeCardPopup", async () => {
  const h = await open({ board: board(), light, w: 1300, h: 900 });
  const pg = h.page;
  await idle(h);
  await pg.locator('.card[data-id="k1"] .chead .ctitle').click({ button: "right" });
  await pg.locator(".ctx.open").first().waitFor();
  await pg.locator('.ctx.open button:has(.lb:text-is("Add"))').first().hover();
  await until(h, "the Add submenu", async () => (await pg.locator(".ctx.open").count()) > 1);
  await pg.locator('.ctx.open button:has(.lb:text-is("Sidenote"))').last().click();
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
  await pg.locator('.card[data-id="k1"] .chead .mk').click();
  await pg.locator(W).waitFor();
  await pg.locator(`${W} .hh button`).first().click();
  await until(h, "Delete removes the card's sidenotes", () => !h.board().sidenotes.some((x) => !x.at.lines));
  await expect(pg.locator(W)).toHaveCount(0);
  check(
    "sidenoteWholeCardPopup Add ▸ Sidenote opens the card's popup beside it, input focused; Delete and Close in its title bar",
    !n.at.lines &&
      !n.at.seg &&
      p.x >= c.r &&
      chrome.bar.join("|") === "Delete Sidenotes|Close" &&
      chrome.slips === 1 &&
      chrome.tools === 1 &&
      h.board().sidenotes.length === 2,
    { n, p, c, chrome },
  );
  await h.close();
});
