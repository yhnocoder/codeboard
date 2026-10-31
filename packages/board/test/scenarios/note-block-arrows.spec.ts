import { put, shot, type Host } from "../harness";
import { blockSig, emptyBoard, DEFAULT_SETTINGS, THEMES, type Board, type Link, type NoteCard } from "@codeboard/core";
import type { Page } from "playwright-core";
import { test, open, check, light, until, idle, pmHasSelection, focusSettled } from "../fixtures";

const close = (h: Host) => h.page.context().close();

const ROOF = "Roofline model: bandwidth slope and compute roof.";
/** A：开头是标题（卡头就是它，正文里藏起来），后面一段、Roofline 那段、列表、代码块 */
const A = ["# Compute intensity", "Intro.", ROOF, "- vecAdd: 0.25 FLOP/B\n- tiled matmul: grows with the tile", "```\nratio = flops / bytes\n```"];
/** B：两段、公式、表格、引用 */
const B = ["Shared memory is shared by the threads of a block.", "Load tiles of M and N first.", "$$\\frac{2}{8} = 0.25$$",
  "| Memory | Scope | Latency |\n|---|---|---|\n| register | thread | 1 |\n| shared | block | 30 |", "> Quote block."];
const TABLE = 3;

function board(links: Link[] = [], theme = "warm-ink"): { b: Board; theme: string } {
  const b = emptyBoard("b1", "note blocks");
  put(b, { id: "na", kind: "note", md: A.join("\n\n"), look: "note" } as NoteCard, 60, 60, 420);
  put(b, { id: "nb", kind: "note", md: B.join("\n\n"), look: "note" } as NoteCard, 640, 90, 420);
  b.links.push(...links);
  b.cam = { x: 0, y: 0, z: 1 };
  return { b, theme };
}
const openBoard = (o: { b: Board; theme: string }) => open({ board: o.b, light, w: 1200, h: 760, settings: { theme: o.theme } as any });

/** 第 i 块（静态显示，或开着的编辑器里）在屏幕上的框 */
const blockBox = (pg: Page, card: string, i: number) => pg.evaluate(([card, i]) => {
  const body = document.querySelector(`.card[data-id="${card}"] > .cface > .nbody`)!;
  const el = [...(body.querySelector(".md-pm") ?? body).children].filter((k) => !k.classList.contains("md-pad"))[+i] as HTMLElement;
  const r = el.getBoundingClientRect();
  return { x: r.x, y: r.y, w: r.width, h: r.height, mid: r.y + r.height / 2 };
}, [card, String(i)] as const);
const cardBox = (pg: Page, card: string) => pg.evaluate((card) => { const r = document.querySelector(`.card[data-id="${card}"]`)!.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; }, card);
const headBox = (pg: Page, card: string) => pg.evaluate((card) => { const r = document.querySelector(`.card[data-id="${card}"] .chead`)!.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; }, card);
/** 哪几块上着淡色底：「卡:第几块」（背景图是那层颜色，外面一圈同色的 box-shadow） */
const tinted = (pg: Page) => pg.evaluate(() => [...document.querySelectorAll<HTMLElement>(".card.note > .cface > .nbody.md:not(.editing) > *, .card.note > .cface > .nbody .md-pm > :not(.md-pad)")]
  .filter((el) => { const s = getComputedStyle(el); return s.backgroundImage.includes("gradient") && s.boxShadow.includes("6px"); })
  .map((el) => `${el.closest<HTMLElement>(".card")!.dataset.id}:${[...el.parentElement!.children].filter((k) => !k.classList.contains("md-pad")).indexOf(el)}`).sort());
/** 线的终点（世界坐标 = 屏幕坐标：镜头在原点、不缩放） */
const arrowEnd = (pg: Page, id: string) => pg.evaluate((id) => {
  const d = document.querySelector(`g.link[data-lk="${id}"] path.edge`)?.getAttribute("d") ?? "";
  const n = d.match(/-?\d+(\.\d+)?/g)?.map(Number) ?? [];
  return { x: n[n.length - 2], y: n[n.length - 1] };
}, id);
const ports = (pg: Page) => pg.evaluate(() => [...document.querySelectorAll<HTMLElement>(".bport")].map((e) => { const r = e.getBoundingClientRect(); return { side: e.classList.contains("l") ? "l" : "r", x: r.x + r.width / 2, y: r.y + r.height / 2 }; }));

/** 停在 card 的第 i 块上，等两个圆点出来 */
async function hoverBlock(h: Host, card: string, i: number) {
  const r = await blockBox(h.page, card, i);
  await h.page.mouse.move(r.x + 30, r.mid);
  await until(h, "the block's ports show", async () => (await ports(h.page)).length === 2 || null);
  await idle(h);
}
/** 从 card 第 i 块的一个圆点按下，拖到 at（during：松手前看一眼），松手；返回新连的线 */
async function dragFrom(h: Host, card: string, i: number, side: "l" | "r", at: () => Promise<{ x: number; y: number }>, during?: () => Promise<void>) {
  await hoverBlock(h, card, i);
  const p = (await ports(h.page)).find((x) => x.side === side)!;
  const n = h.board().links.length;
  await h.page.mouse.move(p.x, p.y); await h.page.mouse.down();
  const t = await at();
  await h.page.mouse.move(t.x, t.y, { steps: 8 });
  await idle(h);
  await during?.();
  await h.page.mouse.up();
  await until(h, "the dragged arrow is saved", () => h.board().links.length > n || null); await idle(h);
  return h.board().links[h.board().links.length - 1] as Link;
}

/** 打一串：{Enter}、{Shift+End} 之类是按键，其余是字（方向键前后等 ProseMirror 读到选区） */
async function keys(pg: Page, seq: string) {
  for (const part of seq.split(/(\{[A-Za-z0-9+]+\})/)) {
    if (!part) continue;
    if (/^\{.+\}$/.test(part)) {
      const nav = /Home|End|Arrow/.test(part);
      if (nav) { await focusSettled(pg); await pmHasSelection(pg); }
      await pg.keyboard.press(part.slice(1, -1));
      if (nav) await pmHasSelection(pg);
    } else await pg.keyboard.type(part);
  }
}
/** 双击 card 的第 i 块进编辑，按 seq 打字，Esc 存好退出 */
async function editBlock(h: Host, card: string, i: number, seq: string) {
  const r = await blockBox(h.page, card, i);
  await h.page.mouse.dblclick(r.x + 12, r.mid);
  await h.page.locator(`.card[data-id="${card}"] .md-pm:focus`).waitFor();
  await keys(h.page, seq);
  for (let k = 0; k < 3 && (await h.page.locator(".md-pm").count()); k++) { await h.page.keyboard.press("Escape"); await idle(h); }
}
const mdOf = (h: Host, id: string) => (h.board().cards.find((c) => c.id === id) as NoteCard).md;

/** 悬停 Note 的一块：卡左右边上、那一块中线的高度出两个圆点，盖在连着这一块的线头上面；块本身不上底色 */
test("noteBlockHoverShowsPortsNoTint", async () => {
  const h = await openBoard(board([{ id: "in", from: { card: "nb" }, to: { card: "na", block: { i: 2, h: blockSig(ROOF) } } }]));
  await hoverBlock(h, "na", 2);
  const ps = await ports(h.page), blk = await blockBox(h.page, "na", 2), c = await cardBox(h.page, "na");
  const style = await h.page.evaluate(() => { const el = document.querySelector('.card[data-id="na"] > .cface > .nbody')!.children[2]; const s = getComputedStyle(el); return { bg: s.backgroundImage, sh: s.boxShadow, bc: s.backgroundColor }; });
  const left = ps.find((p) => p.side === "l"), right = ps.find((p) => p.side === "r");
  // 连着这一块的线头就在左边圆点那里：指针下最上面的是圆点
  const top = left ? await h.page.evaluate(([x, y]) => (document.elementFromPoint(x, y) as HTMLElement | null)?.className ?? "", [left.x, left.y]) : "";
  await shot(h, "note-blocks-hover");
  const at = (p: typeof left, x: number) => !!p && Math.abs(p.x - x) <= 1.5 && Math.abs(p.y - blk.mid) <= 1.5;
  const ok = ps.length === 2 && at(left, c.x) && at(right, c.x + c.w) && /\bbport\b/.test(top) && style.bg === "none" && style.sh === "none" && /rgba\(0, 0, 0, 0\)|transparent/.test(style.bc);
  check("block-hover-ports", ok, JSON.stringify({ ps, blk: blk.mid, card: [c.x, c.x + c.w], top, style }));
  await close(h);
});

/** 从一块拖到另一张 Note 的一块：线两端都记着块，终点在那一块中线高度的卡边上；拖着时起点和落点两块上淡色底，换一块时终点滑过去 */
test("noteBlockDragLinksBlockToBlock", async () => {
  const h = await openBoard(board());
  let during: { tint: string[]; glide: number[]; goal: number; ends: number } | null = null;
  const L = await dragFrom(h, "na", 2, "r", async () => { const r = await blockBox(h.page, "nb", 1); return { x: r.x + 40, y: r.mid }; }, async () => {
    const tint1 = await tinted(h.page);
    await shot(h, "note-blocks-drag-paragraph", "now");
    // 换到表格：终点一帧帧挪过去，中间至少有一帧在两块之间
    const t = await blockBox(h.page, "nb", TABLE), from = await blockBox(h.page, "nb", 1);
    await h.page.evaluate(() => {
      const w = window as any; w.__rub = [];
      const p = document.querySelector("path.edge.rubber")!;
      w.__rubMo = new MutationObserver(() => { const n = p.getAttribute("d")!.match(/-?\d+(\.\d+)?/g)!.map(Number); w.__rub.push(n[n.length - 1]); });
      w.__rubMo.observe(p, { attributes: true, attributeFilter: ["d"] });
    });
    await h.page.mouse.move(t.x + 40, t.mid);
    await until(h, "the arrow's end reaches the table", () => h.page.evaluate((y) => { const r: number[] = (window as any).__rub; return r.length > 0 && Math.abs(r[r.length - 1] - y) < 1; }, t.mid));
    const glide: number[] = await h.page.evaluate(() => { (window as any).__rubMo.disconnect(); return (window as any).__rub; });
    await idle(h);
    during = { tint: [...tint1, "|", ...(await tinted(h.page))], glide, goal: t.mid, ends: glide.filter((y) => y > Math.min(from.mid, t.mid) + 1 && y < Math.max(from.mid, t.mid) - 1).length };
    await shot(h, "note-blocks-drag-table", "now");
  });
  await idle(h);
  const tAfter = await tinted(h.page);
  const end = await arrowEnd(h.page, L.id), tb = await blockBox(h.page, "nb", TABLE), cb = await cardBox(h.page, "nb");
  await shot(h, "note-blocks-linked");
  const d = during as unknown as NonNullable<typeof during>;
  const ok = L.from.card === "na" && L.from.block?.i === 2 && L.from.block.h === blockSig(ROOF) && L.to.card === "nb" && L.to.block?.i === TABLE && L.to.block.h === blockSig(B[TABLE])
    && Math.abs(end.y - tb.mid) <= 1.5 && Math.abs(end.x - cb.x) <= 12
    && d?.tint.join(" ") === "na:2 nb:1 | na:2 nb:3" && d.ends >= 1 && tAfter.length === 0;
  check("block-to-block", ok, JSON.stringify({ from: L.from, to: L.to, end, table: [cb.x, tb.mid], during: d, tAfter }));
  await close(h);
});

/** 拖到块之间的空隙、正文上下的内边距：连最近的那一块（不是整张卡）；只有卡头连整张卡（落点不上底色，起点那段照样上）*/
test("noteBlockGapPicksNearestHeaderPicksCard", async () => {
  const h = await openBoard(board());
  const got: Record<string, unknown> = {};
  // 第 1、2 块之间的空隙，靠第 2 块那边
  const gap = await dragFrom(h, "na", 2, "r", async () => { const r = await blockBox(h.page, "nb", 2); return { x: r.x + 60, y: r.y - 1.5 }; }, async () => { got.gapTint = await tinted(h.page); });
  // 正文上面的内边距：第一块；下面的内边距：最后一块
  const topPad = await dragFrom(h, "na", 2, "r", async () => { const r = await blockBox(h.page, "nb", 0); return { x: r.x + 60, y: r.y - 4 }; });
  const botPad = await dragFrom(h, "na", 2, "r", async () => { const r = await blockBox(h.page, "nb", 4); return { x: r.x + 60, y: r.y + r.h + 5 }; });
  // 卡头：整张卡
  const head = await dragFrom(h, "na", 1, "r", async () => { const r = await headBox(h.page, "nb"); return { x: r.x + r.w / 2, y: r.y + r.h / 2 }; }, async () => { got.headTint = await tinted(h.page); got.ring = await h.page.locator('.card.drop-hot[data-id="nb"]').count(); });
  const end = await arrowEnd(h.page, head.id), hb = await headBox(h.page, "nb");
  const ok = gap.to.block?.i === 2 && topPad.to.block?.i === 0 && botPad.to.block?.i === 4 && head.to.card === "nb" && !head.to.block && Math.abs(end.y - (hb.y + hb.h / 2)) <= 3
    && (got.gapTint as string[]).join(" ") === "na:2 nb:2" && (got.headTint as string[]).join(" ") === "na:1" && got.ring === 1;
  check("block-gap-nearest", ok, JSON.stringify({ gap: gap.to, topPad: topPad.to, botPad: botPad.to, head: head.to, end, head0: hb.y + hb.h / 2, got }));
  await close(h);
});

/** 改 Note 的字：上面插一段、改写那一段，线还连着同一块（终点跟着它的中线）；删掉那一段，线退到整张卡 */
test("noteBlockAnchorFollowsEditsFallsBackWhenDeleted", async () => {
  const h = await openBoard(board([{ id: "in", from: { card: "nb" }, to: { card: "na", block: { i: 2, h: blockSig(ROOF) } } }]));
  const endAt = async (i: number) => { const e = await arrowEnd(h.page, "in"), b = await blockBox(h.page, "na", i); return Math.round(Math.abs(e.y - b.mid) * 10) / 10; };
  const before = await endAt(2);
  // 「Intro.」那段末尾回车，插一段新的：Roofline 那段成了第 3 块
  await editBlock(h, "na", 1, "{End}{Enter}Inserted paragraph.");
  await until(h, "the inserted paragraph is saved", () => mdOf(h, "na").includes("Inserted paragraph.") || null); await idle(h);
  const afterInsert = { to: (h.board().links[0] as Link).to, off: await endAt(3) };
  // 改写 Roofline 那段（同一段换了字）
  const RE = "Roofline model (Williams 2009): ridge point.";
  await editBlock(h, "na", 3, `{Home}{Shift+End}${RE}`);
  await until(h, "the rewritten paragraph is saved", () => mdOf(h, "na").includes(RE) || null); await idle(h);
  const afterRewrite = { to: (h.board().links[0] as Link).to, off: await endAt(3) };
  await shot(h, "note-blocks-follow-edit");
  // 删掉这一段：线退到整张卡（终点在卡头）
  await editBlock(h, "na", 3, "{Home}{Shift+End}{Backspace}{Backspace}");
  await until(h, "the deletion is saved", () => !mdOf(h, "na").includes("Roofline") || null); await idle(h);
  const gone = (h.board().links[0] as Link).to, e = await arrowEnd(h.page, "in"), hb = await headBox(h.page, "na");
  const ok = before <= 1.5 && afterInsert.to.block?.i === 3 && afterInsert.to.block.h === blockSig(ROOF) && afterInsert.off <= 1.5
    && afterRewrite.to.block?.i === 3 && afterRewrite.to.block.h === blockSig(RE) && afterRewrite.off <= 1.5
    && gone.card === "na" && !gone.block && Math.abs(e.y - (hb.y + hb.h / 2)) <= 3;
  check("block-follows-edits", ok, JSON.stringify({ before, afterInsert, afterRewrite, gone, e, head: hb.y + hb.h / 2, md: mdOf(h, "na") }));
  await close(h);
});

/** Note 开着编辑器时：块上不出圆点；拖箭头落到它上面照样认块、上淡色底，退出编辑后线连着那一块 */
test("noteBlockDropOnEditingNote", async () => {
  const h = await openBoard(board());
  const r = await blockBox(h.page, "nb", 1);
  await h.page.mouse.dblclick(r.x + 12, r.mid);
  await h.page.locator('.card[data-id="nb"] .md-pm:focus').waitFor(); await idle(h);
  const b1 = await blockBox(h.page, "nb", 1);
  await h.page.mouse.move(b1.x + 30, b1.mid); await idle(h);
  const portsWhileEditing = (await ports(h.page)).length;
  let tint: string[] = [];
  const L = await dragFrom(h, "na", 2, "r", async () => { const t = await blockBox(h.page, "nb", TABLE); return { x: t.x + 40, y: t.mid }; }, async () => { tint = await tinted(h.page); });
  for (let k = 0; k < 3 && (await h.page.locator(".md-pm").count()); k++) { await h.page.keyboard.press("Escape"); await idle(h); }
  const end = await arrowEnd(h.page, L.id), tb = await blockBox(h.page, "nb", TABLE);
  const ok = portsWhileEditing === 0 && tint.join(" ") === "na:2 nb:3" && L.to.block?.i === TABLE && L.to.block.h === blockSig(B[TABLE]) && Math.abs(end.y - tb.mid) <= 1.5;
  check("block-drop-editing", ok, JSON.stringify({ portsWhileEditing, tint, to: L.to, end, table: tb.mid }));
  await close(h);
});

/** 每个主题里：圆点出得来，拖着指向一块时起点和落点两块都上了看得见的淡色底（不连：拖回空白处松手） */
test("noteBlockTintEveryTheme", async () => {
  const h = await openBoard(board());
  const out: Record<string, unknown> = {};
  for (const [theme] of THEMES) {
    await h.post({ type: "host", host: { settings: { ...DEFAULT_SETTINGS, theme } } as never }); await idle(h);
    await hoverBlock(h, "na", 2);
    const p = (await ports(h.page)).find((x) => x.side === "r")!;
    const t = await blockBox(h.page, "nb", 1);
    await h.page.mouse.move(p.x, p.y); await h.page.mouse.down();
    await h.page.mouse.move(t.x + 40, t.mid, { steps: 6 }); await idle(h);
    const tint = await tinted(h.page);
    const alpha = await h.page.evaluate(() => { const c = getComputedStyle(document.querySelector('.card[data-id="nb"] > .cface > .nbody')!.children[1]).boxShadow; const m = c.match(/rgba?\(([^)]+)\)|color\(srgb ([^)]+)\)/); const v = (m?.[1] ?? m?.[2] ?? "").split(/[ ,/]+/).filter(Boolean).map(Number); return v.length === 4 ? v[3] : v.length === 3 ? 1 : 0; });
    await h.page.mouse.move(600, 600, { steps: 4 }); await h.page.mouse.up(); await idle(h);
    out[theme] = { tint: tint.join(" "), alpha };
  }
  const ok = Object.values(out).every((x) => { const r = x as { tint: string; alpha: number }; return r.tint === "na:2 nb:1" && r.alpha > 0.02 && r.alpha < 0.3; }) && h.board().links.length === 0;
  check("block-tint-themes", ok, JSON.stringify(out));
  await close(h);
});
