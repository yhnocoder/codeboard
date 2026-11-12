import type { Page } from "playwright-core";
import { put, shot, type Host } from "../harness";
import { emptyBoard, type NoteCard } from "@codeboard/core";
import { BAND_GRACE } from "@yhnocoder/markdown/ui";
import { test, open, check, light, until, idle, hold, focusSettled, pmHasSelection } from "../fixtures";

// The toolbar bands of a Note's code blocks and tables: a strip in the block's colour grown upward out of the block's top edge,
// floating over what is above it (nothing moves, the card keeps its size); a table's band also keeps what does not fit in ⋯,
// and its rows and columns can be dragged to another place by their grips.

const close = (h: Host) => h.page.context().close();
const card = (id: string) => `.card[data-id="${id}"]`;
const md = (h: Host, id: string) => ((h.board().cards.find((c) => c.id === id) as NoteCard).md ?? "").trim();

function board(notes: { md: string; w: number }[]) {
  const b = emptyBoard("b1", "bands");
  notes.forEach((n, i) =>
    put(b, { id: `n${i}`, kind: "note", md: n.md, look: "note" } as NoteCard, 40 + i * 620, 60, n.w),
  );
  b.cam = { x: 0, y: 0, z: 1 };
  return b;
}
async function editNote(h: Host, id: string) {
  await h.page
    .locator(`${card(id)} .nbody p`)
    .last()
    .dblclick();
  await h.page.locator(`${card(id)} .md-pm:focus`).waitFor();
  await focusSettled(h.page);
}
async function exitEdit(h: Host) {
  for (let k = 0; k < 3 && (await h.page.locator(".md-pm").count()); k++) {
    await h.page.keyboard.press("Escape");
    await idle(h);
  }
}
const cellText = (pg: Page, id: string) =>
  pg
    .locator(`${card(id)} .md-pm table tr`)
    .evaluateAll((rs) => rs.map((r) => [...r.children].map((c) => (c as HTMLElement).innerText.trim()).join(",")));
async function intoCell(h: Host, id: string, text: string) {
  await h.page.locator(`${card(id)} .md-pm :is(td, th)`, { hasText: new RegExp(`^${text}$`) }).click();
  await pmHasSelection(h.page);
}
/** Where every block of the Note's editor and the card are: a band coming up must move none of them */
const layout = (pg: Page, id: string) =>
  pg.evaluate((sel) => {
    const c = document.querySelector(sel)!,
      r = (e: Element) => {
        const b = e.getBoundingClientRect();
        return [b.left, b.top, b.width, b.height].map((v) => Math.round(v * 10) / 10).join(",");
      };
    return [r(c), ...[...c.querySelectorAll(".md-pm > *")].map(r)].join(" | ");
  }, card(id));
/** The band's face and what shows on it */
const bandState = (pg: Page, sel: string) =>
  pg.locator(sel).evaluate((b) => {
    const f = b.querySelector(".md-band-face")!.getBoundingClientRect();
    return {
      on: b.classList.contains("on"),
      face: [f.left, f.top, f.width, f.height].map((v) => Math.round(v * 10) / 10),
      shown: [...b.querySelectorAll<HTMLElement>("[data-act]")].filter((x) => x.offsetParent).map((x) => x.dataset.act),
    };
  });

const CODE =
  "Some words above the code block, enough of them to fill a line\n\n```python\nx = compute(1)\n```\n\nafter";

/** A narrow Note's code block: hovering it brings its band up above the block, over the line above; nothing moves, the
 *  block's first line of code stays clickable (the old pill sat on it); the pointer crossing onto the band keeps it up, and it
 *  goes once the pointer leaves */
test("codeBlockBandFloats", async () => {
  const h = await open({ board: board([{ md: CODE, w: 240 }]), light });
  const pg = h.page;
  await idle(h);
  await editNote(h, "n0");
  await pg.mouse.move(2, 2);
  await idle(h);
  const before = await layout(pg, "n0");
  const pre = pg.locator(`${card("n0")} .md-pm pre.md-code`),
    band = `${card("n0")} .md-band-code`;
  const p = (await pre.boundingBox())!;
  await pg.mouse.move(p.x + p.width / 2, p.y + p.height - 6);
  await pg.locator(`${band}.on`).waitFor();
  await idle(h);
  const after = await layout(pg, "n0");
  const geo = await pg.evaluate(
    ([pre, band]) => {
      const p = document.querySelector(pre)!,
        b = document.querySelector(band)!.querySelector(".md-band-face")!.getBoundingClientRect(),
        r = p.getBoundingClientRect(),
        line = p.querySelector(".cm-line")!.getBoundingClientRect(),
        hit = document.elementFromPoint(line.left + 4, line.top + line.height / 2);
      return {
        attached: Math.abs(b.bottom - r.top) < 1 && Math.abs(b.left - r.left) < 1 && Math.abs(b.width - r.width) < 1,
        height: Math.round(b.height),
        codeFree: !!hit?.closest(".cm-content"),
      };
    },
    [`${card("n0")} .md-pm pre.md-code`, band],
  );
  await shot(h, "codeBlockBandFloats");
  // up across the seam onto the band, and resting there past the grace time: it stays
  const f = (await pg.locator(`${band} .md-band-face`).boundingBox())!;
  await pg.mouse.move(f.x + 40, f.y + f.height / 2, { steps: 4 });
  await hold(h, BAND_GRACE * 3, "the pointer rests on the band: the band must not go");
  const kept = await bandState(pg, band);
  await pg.mouse.move(2, 2);
  await until(h, "the band goes once the pointer leaves", async () => !(await bandState(pg, band)).on);
  check("codeBlockBandFloats nothing moves", before === after, { before, after });
  check("codeBlockBandFloats band above the block", geo.attached && geo.height === 30 && geo.codeFree, geo);
  check("codeBlockBandFloats stays while pointed at", kept.on, kept);
  await exitEdit(h);
  await close(h);
});

const TABLE =
  "| name | kind | size |\n| --- | --- | --: |\n| alpha | first | 12 |\n| beta | second | 7 |\n| gamma | spare | 128 |";

/** A row dragged by its grip lands where it is dropped, a column too (its alignment with it); each move is one undo step, and the
 *  table's band stays exactly as it is while the drag goes on */
test("noteTableRowColumnDrag", async () => {
  const h = await open({ board: board([{ md: `Pools:\n\n${TABLE}\n\nafter`, w: 560 }]), light });
  const pg = h.page;
  await idle(h);
  await editNote(h, "n0");
  await intoCell(h, "n0", "alpha");
  const band = `${card("n0")} .md-band-table`;
  await pg.locator(`${band}.on`).waitFor();
  // the "alpha" row down below "gamma"
  await pg.locator(`${card("n0")} .md-pm td`, { hasText: /^first$/ }).hover();
  const grip = pg.locator(`${card("n0")} .md-tgrip.row.on`);
  await grip.waitFor();
  await idle(h);
  const still = await bandState(pg, band);
  const g = (await grip.boundingBox())!,
    gamma = (await pg.locator(`${card("n0")} .md-pm td`, { hasText: /^gamma$/ }).boundingBox())!;
  await pg.mouse.move(g.x + 4, g.y + 8);
  await pg.mouse.down();
  await pg.mouse.move(g.x + 4, g.y + 20, { steps: 3 });
  await pg.mouse.move(g.x + 4, gamma.y + gamma.height, { steps: 6 });
  await pg.locator(`${card("n0")} .md-tghost`).waitFor();
  const during = await bandState(pg, band);
  await shot(h, "noteTableRowColumnDrag-row", "now");
  await pg.mouse.up();
  await until(h, "the row moved", async () => (await cellText(pg, "n0"))[3] === "alpha,first,12");
  await idle(h);
  const rows = await cellText(pg, "n0");
  const afterDrop = await bandState(pg, band);
  // the "size" column (right-aligned) to the front
  await pg.locator(`${card("n0")} .md-pm th`, { hasText: /^size$/ }).hover();
  const cg = pg.locator(`${card("n0")} .md-tgrip.col.on`);
  await cg.waitFor();
  const c = (await cg.boundingBox())!,
    name = (await pg.locator(`${card("n0")} .md-pm th`, { hasText: /^name$/ }).boundingBox())!;
  await pg.mouse.move(c.x + 8, c.y + 3);
  await pg.mouse.down();
  await pg.mouse.move(c.x - 10, c.y + 3, { steps: 3 });
  await pg.mouse.move(name.x - 20, c.y + 3, { steps: 8 });
  await pg.mouse.up();
  await until(h, "the column moved", async () => (await cellText(pg, "n0"))[0] === "size,name,kind");
  await idle(h);
  const cols = await cellText(pg, "n0");
  // one undo: the column back; another: the row back
  await pg.keyboard.press("ControlOrMeta+z");
  await until(h, "undo: the column back", async () => (await cellText(pg, "n0"))[0] === "name,kind,size");
  const undo1 = await cellText(pg, "n0");
  await pg.keyboard.press("ControlOrMeta+z");
  await until(h, "undo: the row back", async () => (await cellText(pg, "n0"))[1] === "alpha,first,12");
  await pg.keyboard.press("ControlOrMeta+Shift+z");
  await pg.keyboard.press("ControlOrMeta+Shift+z");
  await until(h, "redo both", async () => (await cellText(pg, "n0"))[0] === "size,name,kind");
  await exitEdit(h);
  const saved = md(h, "n0");
  check(
    "noteTableRowColumnDrag row",
    JSON.stringify(rows) === JSON.stringify(["name,kind,size", "beta,second,7", "gamma,spare,128", "alpha,first,12"]),
    rows,
  );
  check("noteTableRowColumnDrag column", cols[3] === "12,alpha,first", cols);
  check("noteTableRowColumnDrag one undo step each", undo1[3] === "alpha,first,12", undo1);
  check("noteTableRowColumnDrag band unchanged while dragging", JSON.stringify(still) === JSON.stringify(during), {
    still,
    during,
  });
  check("noteTableRowColumnDrag band still up after the drop", afterDrop.on, afterDrop);
  const lines = saved
    .split("\n")
    .filter((l) => l.startsWith("|"))
    .map((l) =>
      l
        .split("|")
        .slice(1, -1)
        .map((x) => x.trim()),
    );
  check(
    "noteTableRowColumnDrag saved",
    JSON.stringify([lines[0], ...lines.slice(2)]) ===
      JSON.stringify([
        ["size", "name", "kind"],
        ["7", "beta", "second"],
        ["128", "gamma", "spare"],
        ["12", "alpha", "first"],
      ]) &&
      /^-+:$/.test(lines[1][0]) &&
      !/:/.test(lines[1][1] + lines[1][2]) &&
      saved.startsWith("Pools:\n\n") &&
      saved.endsWith("\n\nafter"),
    saved,
  );
  await close(h);
});

/** The table's band is as wide as the table: a small table keeps the most used actions on it and the rest in ⋯ (with Delete
 *  table), a wide one shows them all */
test("noteTableBandOverflow", async () => {
  const wide =
    "| name | kind | size | note | owner |\n| - | - | - | - | - |\n| alpha | first | 12 | warm cache kept for the decode steps of every rank | the scheduler's pool |";
  const h = await open({
    board: board([
      { md: `x\n\n| a | b |\n| - | - |\n| 1 | 2 |\n\ny`, w: 400 },
      { md: `x\n\n${wide}\n\ny`, w: 560 },
    ]),
    light,
    w: 1300,
  });
  const pg = h.page;
  await idle(h);
  const res: Record<string, unknown> = {};
  for (const [id, cell] of [
    ["n0", "1"],
    ["n1", "alpha"],
  ]) {
    await editNote(h, id);
    await intoCell(h, id, cell);
    const band = `${card(id)} .md-band-table`;
    await pg.locator(`${band}.on`).waitFor();
    await idle(h);
    const st = await bandState(pg, band);
    await pg.locator(`${band} [data-act="more"]`).click();
    const items = (await pg.locator(".md-bandmenu button").allInnerTexts()).map((t) => t.trim());
    await shot(h, `noteTableBandOverflow-${id}`);
    await pg.keyboard.press("Escape");
    await pg.locator(".md-bandmenu").waitFor({ state: "detached" });
    res[id] = { shown: st.shown, items };
    await exitEdit(h);
  }
  const narrow = res.n0 as { shown: string[]; items: string[] },
    full = res.n1 as { shown: string[]; items: string[] };
  check(
    "noteTableBandOverflow narrow",
    narrow.shown[0] === "grid" &&
      narrow.shown.at(-1) === "more" &&
      !narrow.shown.includes("delCol") &&
      narrow.items.includes("Delete column") &&
      narrow.items.at(-1) === "Delete table" &&
      narrow.items.length === 9 - (narrow.shown.length - 2) + 1,
    narrow,
  );
  check(
    "noteTableBandOverflow wide",
    full.shown.length === 11 && JSON.stringify(full.items) === '["Delete table"]',
    full,
  );
  await close(h);
});

/** A table wider than its Note: no cell breaks inside a word, in the editor or at rest; the table scrolls sideways inside the
 *  Note, which keeps its width and does not scroll sideways itself */
test("noteTableCellsKeepWords", async () => {
  const t =
    "| configuration | throughput | description |\n| - | - | - |\n| tensor_parallel_size | 1234567 | pinned for decode on every rank |";
  const h = await open({ board: board([{ md: `Table:\n\n${t}\n\nafter`, w: 300 }]), light });
  const pg = h.page;
  await idle(h);
  const w0 = (await pg.locator(card("n0")).boundingBox())!.width;
  const look = (sel: string) =>
    pg.locator(card("n0")).evaluate((c, sel) => {
      const broken: string[] = [];
      for (const cell of c.querySelectorAll(`${sel} :is(td, th)`)) {
        const walk = document.createTreeWalker(cell, NodeFilter.SHOW_TEXT);
        for (let n = walk.nextNode(); n; n = walk.nextNode())
          for (const m of n.textContent!.matchAll(/\S+/g)) {
            const r = document.createRange();
            r.setStart(n, m.index!);
            r.setEnd(n, m.index! + m[0].length);
            const tops = new Set([...r.getClientRects()].map((x) => Math.round(x.top)));
            if (tops.size > 1) broken.push(m[0]);
          }
      }
      const body = c.querySelector(".nbody")!,
        scroller = c.querySelector(`${sel} table`)!.closest(".tableWrapper") ?? c.querySelector(`${sel} table`)!;
      return {
        broken,
        scrolls: scroller.scrollWidth > scroller.clientWidth + 1,
        bodyScrolls: body.scrollWidth > body.clientWidth + 1,
      };
    }, sel);
  const rest = await look(".nbody");
  await editNote(h, "n0");
  const editing = await look(".md-pm");
  const w1 = (await pg.locator(card("n0")).boundingBox())!.width;
  await shot(h, "noteTableCellsKeepWords");
  await exitEdit(h);
  for (const [k, v] of [
    ["rest", rest],
    ["editing", editing],
  ] as const)
    check(`noteTableCellsKeepWords ${k}`, !v.broken.length && v.scrolls && !v.bodyScrolls, v);
  check("noteTableCellsKeepWords the card keeps its width", Math.abs(w1 - w0) < 0.5, { w0, w1 });
  await close(h);
});

/** Inserting or deleting a row or column from the band slides the other cells from where they were (the new ones fade in, a
 *  removed one fades out where it was) */
test("noteTableInsertSlides", async () => {
  const h = await open({ board: board([{ md: `Pools:\n\n${TABLE}\n\nafter`, w: 560 }]), light });
  const pg = h.page;
  await idle(h);
  await editNote(h, "n0");
  await intoCell(h, "n0", "beta");
  await pg.locator(`${card("n0")} .md-band-table.on`).waitFor();
  await idle(h);
  // every animation started from here on, by what it animates
  await pg.evaluate(() => {
    const w = window as unknown as { __anims: string[] },
      orig = Element.prototype.animate;
    w.__anims = [];
    Element.prototype.animate = function (this: Element, k: Keyframe[] | PropertyIndexedKeyframes | null, o) {
      const props = Array.isArray(k) ? Object.keys(k[0] ?? {}) : Object.keys(k ?? {});
      w.__anims.push(
        `${this.tagName.toLowerCase()}${this.classList.length ? `.${this.classList[0]}` : ""}:${props.join("+")}`,
      );
      return orig.call(this, k, o);
    };
  });
  const anims = async () => {
    const a = await pg.evaluate(() => (window as unknown as { __anims: string[] }).__anims.splice(0));
    return [...new Set(a)].sort();
  };
  const act = async (a: string) => {
    const b = pg.locator(`${card("n0")} .md-band-table [data-act="${a}"]`);
    if (await b.isVisible()) await b.click();
    else {
      await pg.locator(`${card("n0")} .md-band-table [data-act="more"]`).click();
      await pg.locator(".md-bandmenu button", { hasText: (await b.getAttribute("data-tip"))! }).click();
    }
    await idle(h);
  };
  await act("rowAbove");
  const rowIn = await anims();
  await act("colRight");
  const colIn = await anims();
  await act("delRow");
  const rowOut = await anims();
  await exitEdit(h);
  check("noteTableInsertSlides row in", rowIn.includes("td:transform") && rowIn.includes("td:opacity"), rowIn);
  check("noteTableInsertSlides column in", colIn.includes("td:transform") && colIn.includes("th:opacity"), colIn);
  check(
    "noteTableInsertSlides row out",
    rowOut.includes("td:transform") && rowOut.includes("div.md-tgone:opacity"),
    rowOut,
  );
  await close(h);
});
