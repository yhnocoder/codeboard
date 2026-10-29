// Split by Headings (Note right-click): the first heading's level L decides; every heading of level ≤ L+1 starts a new Note
// titled by it, deeper ones stay in their card, the text before the first heading stays in the Note. Arrows go parent → child
// (solid), the cards sit in a tree going down without covering other cards, and the whole split is one undo step.
//   splitByHeadingsMakesTree    menu item → five Notes, arrows, layout, ⌘Z back to the one Note
//   splitByHeadingsDisabled     a Note without headings (or only headings in code) has the item greyed out
import { emptyBoard, mdHeading, type Board, type NoteCard } from "@codeboard/core";
import { shot, type Host } from "../harness";
import { test, open, check, light, until, idle } from "../fixtures";

const MD = [
  "第 4 章 计算架构与调度 · 读书笔记（PMPP 第 4 版）。",
  "",
  "## Warp 与 SIMT",
  "",
  "thread block 被分配到 SM 以后，硬件再把它按 **32 个线程**一组切成 warp。",
  "",
  "### Warp 的划分",
  "",
  "$$\\text{warp} = \\left\\lfloor \\frac{t_y \\cdot B_x + t_x}{32} \\right\\rfloor$$",
  "",
  "### 控制流分歧：if-else",
  "",
  "同一个 warp 里的线程走了不同的分支，硬件就把两条路径**依次**执行。",
  "",
  "#### 分歧的代价",
  "",
  "两条路径的时间相加。",
  "",
  "## Occupancy",
  "",
  "occupancy 是 SM 上驻留的 warp 数和它最多能驻留的 warp 数之比。",
  "",
  "### 每个 SM 的资源上限",
  "",
  "| 资源 | 每个 SM |",
  "|---|---|",
  "| 线程 | 2048 |",
  "| warp | 64 |",
].join("\n");

function splitBoard(): Board {
  const b = emptyBoard("b1", "split");
  const add = (c: NoteCard, x: number, y: number, w: number) => { b.cards.push(c); b.place[c.id] = { x, y, w }; };
  add({ id: "n", kind: "note", md: MD, look: "note" }, 520, 60, 300);
  // right under the Note, where the first row of the split would go
  add({ id: "other", kind: "note", md: "A card already on the board", look: "note" }, 600, 260, 300);
  add({ id: "plain", kind: "note", md: "No headings here\n\n```\n# only a comment\n```", look: "note" }, 80, 60, 260);
  b.cam = { x: 0, y: 0, z: 1 };
  return b;
}
const notes = (h: Host) => h.board().cards.filter((c): c is NoteCard => c.kind === "note");
const openMenu = async (h: Host, id: string) => {
  await h.page.locator(`.card[data-id="${id}"] .nbody`).click({ button: "right", position: { x: 40, y: 12 } });
  await h.page.locator(".ctx button").first().waitFor();
  await idle(h);
};
const item = (h: Host) => h.page.locator(".ctx button", { hasText: "Split by Headings" });
/** Every card's box on screen, by id */
const boxes = (h: Host) => h.page.locator(".card").evaluateAll((els) => els.map((e) => { const r = e.getBoundingClientRect(); return { id: (e as HTMLElement).dataset.id!, x: r.x, y: r.y, w: r.width, h: r.height }; }));

test("splitByHeadingsMakesTree", async () => {
  const h = await open({ board: splitBoard(), light, w: 1500, h: 1100 });
  const pg = h.page;
  await openMenu(h, "n");
  check("splitByHeadingsMakesTree menu item enabled", (await item(h).count()) === 1 && !(await item(h).isDisabled()));
  await item(h).click();
  await until(h, "the split is saved", () => notes(h).length === 8);
  await idle(h);
  await shot(h, "split-headings-result");

  const all = notes(h), byTitle = new Map(all.map((c) => [mdHeading(c.md), c]));
  const want = ["Warp 与 SIMT", "Warp 的划分", "控制流分歧：if-else", "Occupancy", "每个 SM 的资源上限"];
  check("splitByHeadingsMakesTree one Note per ## and ### heading", want.every((t) => byTitle.get(t)?.look === "note"), all.map((c) => mdHeading(c.md)));
  const n = all.find((c) => c.id === "n")!;
  check("splitByHeadingsMakesTree text before the first heading stays", n.md === "第 4 章 计算架构与调度 · 读书笔记（PMPP 第 4 版）。", n.md);
  const ifelse = byTitle.get("控制流分歧：if-else")!;
  check("splitByHeadingsMakesTree #### stays inside its card", ifelse.md.includes("#### 分歧的代价") && ifelse.md.includes("两条路径的时间相加。"), ifelse.md);
  check("splitByHeadingsMakesTree the table goes with its heading", byTitle.get("每个 SM 的资源上限")!.md.includes("| warp | 64 |"));
  const id = (t: string) => byTitle.get(t)!.id;
  const edges = h.board().links.map((l) => `${l.from.card}→${l.to.card}${l.style?.dash ? " dashed" : ""}`).sort();
  const wantEdges = [`n→${id("Warp 与 SIMT")}`, `${id("Warp 与 SIMT")}→${id("Warp 的划分")}`, `${id("Warp 与 SIMT")}→${id("控制流分歧：if-else")}`, `n→${id("Occupancy")}`, `${id("Occupancy")}→${id("每个 SM 的资源上限")}`].sort();
  check("splitByHeadingsMakesTree solid arrows parent → child", edges.join() === wantEdges.join(), edges, wantEdges);
  const heads = await pg.locator(".card .ctitle").allTextContents();
  check("splitByHeadingsMakesTree headings are the card titles", want.every((t) => heads.includes(t)), heads);

  // the tree goes down: children in a row under their parent, the row centred under it; nothing overlaps
  const bx = new Map((await boxes(h)).map((r) => [r.id, r]));
  const B = (t: string) => bx.get(id(t))!, N = bx.get("n")!;
  const [a, a1, a2, o, o1] = want.map(B);
  check("splitByHeadingsMakesTree first row under the Note, side by side", a.y > N.y + N.h && Math.abs(a.y - o.y) < 1 && o.x > a.x + a.w, { a, o, N });
  check("splitByHeadingsMakesTree children under their parent, in a row", a1.y > a.y + a.h && Math.abs(a1.y - a2.y) < 1 && a2.x > a1.x + a1.w && o1.y > o.y + o.h, { a1, a2, o1 });
  check("splitByHeadingsMakesTree parent centred over its children", Math.abs(a.x + a.w / 2 - (a1.x + a2.x + a2.w) / 2) < 2 && Math.abs(o.x - o1.x) < 2, { a, a1, a2, o, o1 });
  const rs = [...bx.values()];
  const hit = rs.flatMap((p, i) => rs.slice(i + 1).filter((q) => p.x < q.x + q.w && q.x < p.x + p.w && p.y < q.y + q.h && q.y < p.y + p.h).map((q) => `${p.id}×${q.id}`));
  check("splitByHeadingsMakesTree no cards overlap (the existing card included)", hit.length === 0, hit);

  // one undo step brings the one Note back
  await pg.keyboard.press("Meta+z");
  await until(h, "undo is saved", () => notes(h).length === 3);
  await idle(h);
  check("splitByHeadingsMakesTree ⌘Z undoes the whole split", notes(h).find((c) => c.id === "n")?.md === MD && h.board().links.length === 0, notes(h).map((c) => c.id));
});

test("splitByHeadingsDisabled", async () => {
  const h = await open({ board: splitBoard(), light, w: 1500, h: 1100 });
  await openMenu(h, "plain");
  check("splitByHeadingsDisabled greyed out without headings", (await item(h).count()) === 1 && (await item(h).isDisabled()));
  await h.page.keyboard.press("Escape");
  check("splitByHeadingsDisabled nothing split", notes(h).length === 3);
});
