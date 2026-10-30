import * as fs from "node:fs";
import * as path from "node:path";
import { DEFAULT_SETTINGS, emptyBoard, mapFit, skeletonOf, type Board, type NoteCard } from "@codeboard/core";
import { put, symCard, findSym, shot, OUT, type Host } from "../harness";
import { subHost } from "../subhost";
import { test, until, idle, hold, verdict, check } from "../fixtures";
import { DBL_CLICK, WHEEL_GESTURE } from "../../src/state/timing";

const nv = (qual: string) => { const s = findSym(qual); return symCard(s.f, s.s); };
const note = (id: string, md: string, o: Partial<NoteCard> = {}): NoteCard => ({ id, kind: "note", md, look: "note", ...o });
const svg = (w: number, h: number, c: string) => `data:image/svg+xml;utf8,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><rect width="${w}" height="${h}" fill="${c}"/><circle cx="${w / 2}" cy="${h / 2}" r="${h / 3}" fill="#fff8"/></svg>`)}`;

/**
 * Main holds two sub-boards: Parallel (four sections of notes, an image, ungrouped notes) and Scheduler (code cards in two sections,
 * a handwritten Mark). Scheduler itself holds a Deep board, so [[ can list a card two levels down
 */
export function boards() {
  const P = emptyBoard("bPar", "异构数据并行计算");
  const secs: [string, string, string, number, number][] = [["s1", "异构并行计算", "sand", 40, 40], ["s2", "数据并行性", "green", 40, 700], ["s3", "CUDA 粗略介绍", "blue", 700, 700], ["s4", "以 VectorAdd 为例介绍 Grid, Thread Block, Thread 的基本概念", "pink", 700, 40]];
  for (const [id, title, color, x, y] of secs) P.sections.push({ id, title, x, y, w: 600, h: 600, color });
  const notes: [string, string, string | undefined, string][] = [
    ["p1", "s1", "多核与众核", "## 多核（multicore）与众核（many-core）\nCPU 走多核，GPU 走众核"],
    ["p2", "s1", undefined, "## 降低延迟 vs 提高吞吐\n两种不同的设计目标"],
    ["p3", "s1", undefined, "## CPU 设计：面向延迟\n大缓存、复杂的控制逻辑"],
    ["p4", "s1", undefined, "## GPU 是吞吐量导向的设计\n大量简单核心，用线程数掩盖延迟"],
    ["p5", "s1", undefined, "## 加速比、Amdahl 定律\n串行部分决定加速上限"],
    ["p6", "s1", undefined, "1. 3"],
    ["p7", "s2", undefined, "## 数据并行性意味着什么\n同一操作作用在大量数据上"],
    ["p8", "s2", undefined, "## 例：彩色图像转灰度\n每个像素独立计算"],
    ["p9", "s3", "CUDA C 程序结构", "主机代码 + 设备代码"],
    ["p10", "s3", undefined, "1. 增加 shape(圆角矩形、圆形等)"],
    ["p11", "s4", undefined, "## 骨架\nvecAdd 的三步"],
    ["p12", "s4", undefined, "## Kernel 函数\n用 __global__ 修饰"],
    ["p13", "s4", undefined, "## 线程索引\nblockIdx.x * blockDim.x + threadIdx.x"],
    ["p14", "s4", undefined, "## 处理“小尾巴”\nif (i < n) 防止越界"],
    ["p15", "s4", undefined, "## 消失的循环\nfor 循环变成了一批线程"],
    ["p16", "", undefined, "## Global 内存\n所有线程都能读写"],
    ["p17", "", undefined, "随手记一句没有标题的话"],
  ];
  notes.forEach(([id, sec, title, md], i) => {
    const s = P.sections.find((k) => k.id === sec);
    P.cards.push(note(id, md, title ? { title } : {}));
    P.place[id] = { x: (s?.x ?? 1400) + 20 + (i % 2) * 290, y: (s?.y ?? 40) + 40 + Math.floor((i % 6) / 2) * 180, w: 260, ...(sec ? { section: sec } : {}) };
  });
  P.cards.push({ id: "pImg", kind: "image", src: svg(220, 120, "#6091cd"), alt: "CPU 与 GPU 架构对比" });
  P.place.pImg = { x: 330, y: 760, w: 260, section: "s2" };

  const D = emptyBoard("bDeep", "Deep");
  D.cards.push(note("d1", "## 深处的笔记\n两层下面"));
  D.place.d1 = { x: 40, y: 40, w: 260 };

  const S = emptyBoard("bSch", "nano-vllm 调度器");
  S.sections.push({ id: "sch", title: "Scheduler：每一步挑哪些序列", x: 0, y: 0, w: 1300, h: 900, color: "sand" });
  S.sections.push({ id: "bm", title: "BlockManager：KV cache 按块分配", x: 1400, y: 0, w: 1300, h: 900, color: "blue" });
  const codes: [string, string, number, number][] = [["Scheduler.schedule", "sch", 40, 40], ["Scheduler.preempt", "sch", 640, 40], ["Scheduler.postprocess", "sch", 40, 500],
    ["BlockManager.can_allocate", "bm", 1440, 40], ["BlockManager.allocate", "bm", 2040, 40], ["BlockManager.deallocate", "bm", 1440, 500]];
  for (const [q, sec, x, y] of codes) { const c = nv(q); put(S, c, x, y, 520); S.place[c.id].section = sec; }
  S.cards.push(note("sMark", "待查：preempt 之后前缀缓存还能命中吗？", { look: "mark", hand: "orange" }));
  S.place.sMark = { x: 700, y: 520, w: 220, section: "sch" };
  S.cards.push(note("sNote", "## 抢占\n显存不够就把最后一个踢回 waiting"));
  S.place.sNote = { x: 700, y: 700, w: 260, section: "sch" };
  S.cards.push({ id: "fDeep", kind: "board", board: "bDeep" });
  S.place.fDeep = { x: 2040, y: 500, w: 420, h: 260, section: "bm" };

  const M = emptyBoard("bMain", "Main");
  const step = nv("LLMEngine.step");
  put(M, step, 60, 80, 560);
  M.cards.push(note("mNote", "## 读代码的顺序\n先看 [[LLMEngine.step]]，再进两块子白板"));
  M.place.mNote = { x: 60, y: 520, w: 380 };
  M.cards.push({ id: "fPar", kind: "board", board: "bPar" });
  M.place.fPar = { x: 700, y: 60, w: 620, h: 420 };
  M.cards.push({ id: "fSch", kind: "board", board: "bSch" });
  M.place.fSch = { x: 700, y: 540, w: 620, h: 360 };
  // on Main itself: a note named only by its first line and a picture, which [[ leaves out
  M.cards.push(note("mPlain", "1. 3"), { id: "mImg", kind: "image", src: svg(160, 90, "#d77891") });
  M.place.mPlain = { x: 60, y: 760, w: 200 }; M.place.mImg = { x: 300, y: 760, w: 200 };
  M.cam = { x: -20, y: 24, z: 0.95 };
  return { M, P, S, D, step };
}

/** Screenshot also into SHOTS_DIR when set (the before / after pictures for a PR) */
async function shotPr(h: Host, name: string) {
  await shot(h, name, "now");
  const d = process.env.SHOTS_DIR;
  if (d) { fs.mkdirSync(d, { recursive: true }); fs.copyFileSync(path.join(OUT, `${name}.png`), path.join(d, `${name}.png`)); }
}
/** How many blocks a frame's map draws */
const hasBlocks = (h: Host, frame: string) => h.page.locator(`.card[data-id="${frame}"] .skel [data-sub]`).count();

/** The board's name and card count sit above the frame, outside it; with Sub-board Preview = Title Only the frame draws no map */
test("subboardTitleAboveFrame", async () => {
  const { M, P, S, D } = boards();
  const t = await subHost(M, [P, S, D]), h = t.h, page = h.page;
  await until(h, "the frame shows its board", () => hasBlocks(h, "fSch"));
  await idle(h);
  const frame = page.locator('.card[data-id="fSch"]');
  const title = async () => {
    const [f, n, c] = await Promise.all([frame.boundingBox(), frame.locator(".sbname").boundingBox(), frame.locator(".sbmeta").boundingBox()]);
    // drawn and taking the pointer there (not cut off at the frame's edge)
    const hit = !!n && await page.evaluate(([x, y]) => !!document.elementFromPoint(x, y)?.closest('.card[data-id="fSch"] .sbname'), [n.x + n.width / 2, n.y + n.height / 2]);
    return { above: !!f && !!n && !!c && n.y + n.height <= f.y && c.y + c.height <= f.y && n.x >= f.x && c.x > n.x, hit, name: await frame.locator(".sbname").textContent(), count: await frame.locator(".sbmeta").textContent() };
  };
  const full = await title();
  await shotPr(h, "subboardcard-title");
  check("subboardTitleAboveFrame-outside", full.above && full.hit && full.name === "nano-vllm 调度器" && full.count === "9", full);
  await h.post({ type: "host", host: { settings: { ...DEFAULT_SETTINGS, subPreview: "title" } } });
  await until(h, "Title Only drops the map", async () => (await hasBlocks(h, "fSch")) === 0);
  await idle(h);
  const only = await title();
  check("subboardTitleAboveFrame-titleOnly", only.above && only.hit && only.name === "nano-vllm 调度器" && only.count === "9", only);
  await page.context().close();
});

/**
 * A sub-board of 240 cards: the map draws every one of them inside the frame, smaller; made bigger with its corner grip, the same
 * blocks grow with it. Panning the parent board leaves the map alone (it is built once, not per frame)
 */
test("subboardMapScales", async () => {
  const B = emptyBoard("bBig", "Big");
  for (let s = 0; s < 4; s++) {
    B.sections.push({ id: `s${s}`, title: `Section ${s}`, x: s * 1000, y: 0, w: 900, h: 9000 });
    for (let i = 0; i < 60; i++) {
      const id = `b${s}-${i}`;
      B.cards.push(note(id, `## Card ${s}.${i}\nA one-line summary of card ${i}`));
      B.place[id] = { x: s * 1000 + 20 + (i % 3) * 290, y: 40 + Math.floor(i / 3) * 160, w: 260, section: `s${s}` };
    }
  }
  const M = emptyBoard("bMain", "Main");
  M.cards.push({ id: "fBig", kind: "board", board: "bBig" });
  M.place.fBig = { x: 80, y: 120, w: 500, h: 300 };
  M.cam = { x: 0, y: 0, z: 1 };
  const t = await subHost(M, [B]), h = t.h, page = h.page;
  const frame = page.locator('.card[data-id="fBig"]');
  await until(h, "the frame shows its board", () => hasBlocks(h, "fBig"));
  await idle(h);
  const drawn = () => frame.evaluate((f) => {
    const fr = f.getBoundingClientRect(), hits = [...f.querySelectorAll(".skel [data-sub] .hit")].map((e) => e.getBoundingClientRect());
    (f.querySelector(".sbsvg") as unknown as { __mark?: number }).__mark ??= 1;
    return {
      n: hits.length, w: fr.width, h: fr.height, count: f.querySelector(".sbmeta")?.textContent,
      inside: hits.every((r) => r.left >= fr.left && r.right <= fr.right && r.top >= fr.top && r.bottom <= fr.bottom),
      bw: hits[0]?.width ?? 0,
    };
  });
  const small = await drawn();
  check("subboardMapScales-small", small.count === "240" && small.n === 240 && small.inside, small);
  // panning: the very same SVG stays (marked above), nothing rebuilt
  await page.mouse.move(700, 600);
  await page.mouse.wheel(-150, -90); await idle(h);
  check("subboardMapScales-panKeepsMap", await frame.evaluate((f) => (f.querySelector(".sbsvg") as unknown as { __mark?: number }).__mark === 1));
  // bigger with its corner grip
  await frame.locator(".sbname").click(); await idle(h);
  const grip = (await frame.locator(".grip").boundingBox())!;
  await page.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2);
  await page.mouse.down();
  await page.mouse.move(grip.x + 300, grip.y + 200, { steps: 8 });
  await page.mouse.up();
  await idle(h);
  const big = await drawn();
  check("subboardMapScales-bigger", big.w > small.w && big.h > small.h && big.n === 240 && big.inside && big.bw > small.bw * 1.3, { small, big });
  await page.context().close();
});

/**
 * Made smaller with its corner grip or bottom edge, a frame keeps the size it was dragged to: next to another frame it snaps to the
 * same height, and dragged far past it stops at a minimum size instead of collapsing to a line
 */
test("subboardShrinkKeepsSize", async () => {
  const { P } = boards();
  const M = emptyBoard("bMain", "Main");
  M.cards.push({ id: "fPar", kind: "board", board: "bPar" }, { id: "fNext", kind: "board", board: "bPar" });
  M.place.fPar = { x: 80, y: 120, w: 520, h: 420 };
  M.place.fNext = { x: 700, y: 160, w: 400, h: 260 };
  M.cam = { x: 0, y: 0, z: 1 };
  const t = await subHost(M, [P]), h = t.h, page = h.page;
  const frame = page.locator('.card[data-id="fPar"]');
  await until(h, "the frames show their board", async () => (await hasBlocks(h, "fPar")) > 0 && (await hasBlocks(h, "fNext")) > 0);
  await idle(h);
  const place = () => t.store.peek("bMain")!.place.fPar;
  const shrink = async (sel: string, dx: number, dy: number) => {
    await frame.locator(".sbname").click(); await idle(h);
    const g = (await frame.locator(sel).boundingBox())!;
    const x = g.x + g.width / 2, y = g.y + g.height / 2;
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x + dx, y + dy, { steps: 10 });
    const hint = await page.evaluate(() => document.querySelector(".ghint")?.textContent ?? "");
    await page.mouse.up();
    await idle(h);
    const b = (await frame.boundingBox())!;
    return { hint, w: b.width, h: b.height, place: { ...place() } };
  };
  // the corner grip up-left by ~158px: the height snaps to the neighbour's 260
  const snap = await shrink(".grip", -100, -158);
  check("subboardShrinkKeepsSize-sameHeight", snap.place.h === 260 && Math.abs(snap.h - 260) < 3 && snap.w > 380 && /same height/.test(snap.hint), snap);
  await shotPr(h, "subboardcard-shrink-snap");
  // far past everything: stops at the minimum size, still a frame with its map
  const tiny = await shrink(".grip", -900, -900);
  check("subboardShrinkKeepsSize-min", typeof tiny.place.h === "number" && tiny.h >= 120 && tiny.w >= 180 && Math.abs(tiny.h - tiny.place.h!) < 3 && (await hasBlocks(h, "fPar")) > 0, tiny);
  // a double-click on the grip (Fit Content on other cards) leaves the frame as it is: it has no content size to fit
  const before = { ...place() };
  await frame.locator(".grip").dblclick(); await idle(h);
  check("subboardShrinkKeepsSize-dblclick", place().h === before.h && place().w === before.w && Math.abs((await frame.boundingBox())!.height - before.h!) < 3, { before, after: place() });
  await shotPr(h, "subboardcard-shrink-min");
  await page.context().close();
});

/**
 * The approved design (feedback demo #66, option B "缩略地图"): the title 16px above the frame as before; inside, Sections are tinted
 * regions with their name and count in a fixed 11px label, notes are paper-white blocks with grey lines, code cards have a blue-grey
 * header band, arrows are thin lines at 75%; a hovered block gets an accent outline; the tooltip is the dark tip pill. Warm Ink, light, zoom 100%
 */
test("subboardMatchesDemo", async () => {
  const { M, P, S, D } = boards();
  M.cam = { x: -600, y: 40, z: 1 };
  // two notes in Parallel with an arrow, to see a line on the map
  P.links.push({ id: "pl", from: { card: "p1" }, to: { card: "p2" } });
  const t = await subHost(M, [P, S, D], { light: true }), h = t.h, page = h.page;
  await until(h, "the frame shows its board", () => hasBlocks(h, "fSch"));
  await idle(h);
  const r = await page.evaluate(() => {
    const f = document.querySelector<HTMLElement>('.card[data-id="fPar"]')!, fr = f.getBoundingClientRect();
    const box = (sel: string) => { const e = f.querySelector(sel); if (!e) return null; const b = e.getBoundingClientRect(); return [b.left - fr.left, b.top - fr.top, b.width, b.height].map((v) => +v.toFixed(1)); };
    const css = (root: Element, sel: string, ...ks: string[]) => { const e = root.querySelector(sel); if (!e) return null; const s = getComputedStyle(e); return ks.map((k) => s.getPropertyValue(k)).join(" "); };
    const sch = document.querySelector('.card[data-id="fSch"]')!;
    return {
      zoom: fr.width / f.offsetWidth, name: box(".sbname"), nameCss: css(f, ".sbname", "font-size", "font-weight", "line-height", "color"),
      lab: css(f, ".sblab", "font-size", "font-weight", "color"), labEm: css(f, ".sblab em", "font-weight", "color"),
      sec: css(f, ".sec.c-sand", "fill", "stroke"),
      note: css(f, '.k-note:not(.l-text) .bx', "fill"), bar: css(f, ".k-note .bar:not(.t)", "fill"),
      code: css(sch, ".k-code .bx", "fill"), head: css(sch, ".k-code .hd", "fill"),
      line: css(f, ".ln", "stroke", "stroke-width", "opacity"),
    };
  });
  check("subboardMatchesDemo-title", r.zoom === 1 && !!r.name && Math.abs(r.name[0] - 6) < 0.6 && Math.abs(r.name[1] + 46) < 0.6 && r.nameCss === "25px 700 30px rgb(33, 31, 27)", r);
  check("subboardMatchesDemo-sections", r.lab === "11px 600 rgb(98, 94, 86)" && r.labEm === "500 rgb(154, 149, 139)" && r.sec === "rgba(206, 170, 110, 0.16) rgba(60, 45, 20, 0.16)", r);
  check("subboardMatchesDemo-blocks", r.note === "rgb(253, 252, 250)" && /^color\(srgb|^rgba?\(/.test(r.bar ?? "") && !!r.code && r.code !== r.note && !!r.head, r);
  check("subboardMatchesDemo-line", r.line === "rgb(154, 149, 139) 1px 0.75", r);
  // hover a block: accent outline; its tooltip on the dark pill
  const b = (await page.locator('.card[data-id="fPar"] .skel [data-sub="p1"] .hit').boundingBox())!;
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
  await page.locator(".sbtip").waitFor();
  // the outline fades in (120ms)
  await until(h, "the hovered block's outline", () => page.evaluate(() => getComputedStyle(document.querySelector('.card[data-id="fPar"] [data-sub="p1"] .hit')!).stroke === "rgb(181, 85, 45)"), 2000).catch(() => undefined);
  const hov = await page.evaluate(() => ({
    hit: getComputedStyle(document.querySelector('.card[data-id="fPar"] [data-sub="p1"] .hit')!).stroke,
    tip: (() => { const s = getComputedStyle(document.querySelector(".sbtip")!); return `${s.backgroundColor} ${s.color} ${s.fontSize} ${s.borderRadius}`; })(),
  }));
  check("subboardMatchesDemo-hover", hov.hit === "rgb(181, 85, 45)" && hov.tip === "rgba(34, 32, 28, 0.92) rgb(246, 244, 239) 11.5px 7px", hov);
  await shotPr(h, "subboardcard-demo");
  await page.context().close();
});

/** The wheel over a sub-board card pans the board, selected or not: nothing in the frame scrolls */
test("subboardWheelPansBoard", async () => {
  const { M, P, S, D } = boards();
  const t = await subHost(M, [P, S, D]), h = t.h, page = h.page;
  await until(h, "the frame shows its map", () => hasBlocks(h, "fPar"));
  await idle(h);
  const cam = () => page.evaluate(() => document.querySelector<HTMLElement>(".world")!.style.transform);
  const cols = page.locator('.card[data-id="fPar"] .skel');
  await verdict("subboardWheelPansBoard", async (res) => {
    const c0 = await cam();
    const box = (await cols.boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.wheel(120, 0); await idle(h);
    res.unselectedPans = (await cam()) !== c0;
    // select the frame (its name), then a new gesture over its map
    await page.locator('.card[data-id="fPar"] .sbname').click(); await idle(h);
    res.selected = await page.locator('.card.sel[data-id="fPar"]').count();
    await hold(h, WHEEL_GESTURE, "the panning gesture is over: the next wheel starts a new one");
    const c1 = await cam();
    const moved = (await cols.boundingBox())!;
    await page.mouse.move(moved.x + moved.width / 2, moved.y + moved.height / 2);
    await page.mouse.wheel(200, 200); await idle(h);
    res.selectedPans = (await cam()) !== c1;
    res.scrolled = await cols.evaluate((e) => e.scrollLeft + e.scrollTop);
    return res.unselectedPans && res.selected === 1 && res.selectedPans && res.scrolled === 0;
  });
  await page.context().close();
});

/** An arrow dragged from a card's port onto a block of the map inside the frame attaches to the frame itself: the frame lights up, the arrowhead is on its edge */
test("subboardLinkAttachesToFrame", async () => {
  const { M, P, S, D } = boards();
  const t = await subHost(M, [P, S, D]), h = t.h, page = h.page;
  await until(h, "the frame shows its map", () => hasBlocks(h, "fSch"));
  await idle(h);
  await verdict("subboardLinkAttachesToFrame", async (res) => {
    const nb = (await page.locator('.card[data-id="mNote"]').boundingBox())!;
    await page.mouse.move(nb.x + nb.width / 2, nb.y + nb.height / 2); await idle(h);
    const port = (await page.locator('.card[data-id="mNote"] .eport.r').boundingBox())!;
    const mini = (await page.locator('.card[data-id="fSch"] .skel [data-sub] .hit').first().boundingBox())!;
    await page.mouse.move(port.x + port.width / 2, port.y + port.height / 2);
    await page.mouse.down();
    await page.mouse.move(mini.x + mini.width / 2, mini.y + mini.height / 2, { steps: 10 });
    res.frameHot = await page.locator('.card.drop-hot[data-id="fSch"]').count();
    res.miniHot = await page.locator(".skel .hot").count();
    await page.mouse.up();
    const made = () => t.store.peek("bMain")!.links.find((l) => l.from.card === "mNote");
    await until(h, "the arrow is saved", made); await idle(h);
    res.to = made()!.to;
    const f = (await page.locator('.card[data-id="fSch"]').boundingBox())!;
    res.head = await page.evaluate((id) => {
      const r = document.querySelector(`g.link[data-lk="${id}"] .ahead.end`)?.getBoundingClientRect();
      return r ? { x: r.x + r.width / 2, y: r.y + r.height / 2 } : null;
    }, made()!.id);
    const hd = res.head as { x: number; y: number } | null;
    // the head sits on the frame's outline, not on a block inside it
    const near = (m: number) => !!hd && hd.x > f.x - m && hd.x < f.x + f.width + m && hd.y > f.y - m && hd.y < f.y + f.height + m;
    res.headAtEdge = near(14) && !near(-8);
    await shotPr(h, "subboardcard-arrow");
    return res.frameHot === 1 && res.miniHot === 0 && JSON.stringify(res.to) === JSON.stringify({ card: "fSch" }) && res.headAtEdge;
  });
  await page.context().close();
});

type Frame = { t: number; cam: string; op: number; ghost?: { x: number; y: number; text: string }; board: string };
/**
 * Samples, every frame, the world layer (camera, opacity), the flying title and which board is shown: for at least `ms`, then on
 * until the morph is over (no flying title, the board fully shown), so a slow machine still films the whole flight
 */
function film(page: Host["page"], ms: number): Promise<Frame[]> {
  return page.evaluate((ms) => new Promise<Frame[]>((done) => {
    const out: Frame[] = [], t0 = performance.now();
    const step = () => {
      const w = document.querySelector<HTMLElement>(".world")!, g = document.querySelector<HTMLElement>(".sbmorph");
      const r = g?.getBoundingClientRect();
      out.push({ t: performance.now() - t0, cam: w.style.transform, op: +getComputedStyle(w).opacity, ghost: g && r ? { x: Math.round(r.left), y: Math.round(r.top), text: g.textContent ?? "" } : undefined,
        board: document.querySelector(".mast .mn")?.textContent ?? "" });
      const t = performance.now() - t0, over = !g && out.at(-1)!.op === 1;
      if (t < ms || (!over && t < 6000)) requestAnimationFrame(step); else done(out);
    };
    requestAnimationFrame(step);
  }), ms);
}

/**
 * Entering: the camera stays put, the frame's title flies to the breadcrumb while the boards cross-fade; leaving (Esc, the
 * breadcrumb, ←) flies it back into the frame, with the camera exactly as it was before entering
 */
test("subboardEnterLeaveMorph", async () => {
  const { M, P, S, D } = boards();
  const t = await subHost(M, [P, S, D]), h = t.h, page = h.page;
  await until(h, "the frame shows its map", () => hasBlocks(h, "fPar"));
  await idle(h);
  const cam = () => page.evaluate(() => document.querySelector<HTMLElement>(".world")!.style.transform);
  const title = page.locator('.card[data-id="fPar"] .sbname');
  await verdict("subboardEnterLeaveMorph", async (res) => {
    const c0 = await cam();
    const tb = (await title.boundingBox())!;
    for (const how of ["Escape", "crumb", "back"] as const) {
      let n = t.inits.length;
      const filming = film(page, 600);
      await title.dblclick();
      const f = await filming;
      await until(h, "entering opens the sub-board", () => t.inits.length > n); await idle(h);
      const firstGhost = f.find((x) => x.ghost)?.ghost;
      const cur = (await page.locator(".crumbs .cur").boundingBox())!;
      res[`in-${how}`] = {
        cameraStill: f.filter((x) => x.board === "Main").every((x) => x.cam === c0), faded: Math.min(...f.map((x) => x.op)) < 0.5, ghost: firstGhost?.text,
        from: !!firstGhost && Math.abs(firstGhost.y - tb.y) < 24 && Math.abs(firstGhost.x - tb.x) < 30,
        to: f.some((x) => !!x.ghost && Math.abs(x.ghost.x - cur.x) < 4 && Math.abs(x.ghost.y - cur.y) < 4),
        settled: (await page.evaluate(() => [+getComputedStyle(document.querySelector(".world")!).opacity, !!document.querySelector(".sbmorph")])).join(),
      };
      if (how === "Escape") await shotPr(h, "subboardcard-entered");
      n = t.inits.length;
      const filmBack = film(page, 520);
      if (how === "Escape") await page.keyboard.press("Escape");
      else if (how === "crumb") await page.locator(".crumbs .crumb:not(.cur):not(.back)").first().click();
      else await page.locator(".crumbs .crumb.back").click();
      const g = await filmBack;
      await until(h, "leaving opens Main", () => t.inits.length > n && t.cur() === "bMain"); await idle(h);
      const tb2 = (await title.boundingBox())!;
      res[`out-${how}`] = {
        ghost: g.some((x) => x.ghost?.text === "异构数据并行计算"), faded: Math.min(...g.map((x) => x.op)) < 0.5,
        lands: g.some((x) => !!x.ghost && Math.abs(x.ghost.x - tb2.x) < 12 && Math.abs(x.ghost.y - tb2.y) < 12), camera: (await cam()) === c0,
        titleShown: await title.evaluate((e) => getComputedStyle(e).visibility === "visible"),
      };
    }
    return (["Escape", "crumb", "back"] as const).every((k) => {
      const i = res[`in-${k}`] as Record<string, unknown>, o = res[`out-${k}`] as Record<string, unknown>;
      return i.cameraStill && i.faded && i.ghost === "异构数据并行计算" && i.from && i.to && i.settled === "1,false" && o.ghost && o.faded && o.lands && o.camera && o.titleShown;
    });
  });
  // a picture half way through entering (played 8× slower)
  await page.evaluate(() => document.documentElement.style.setProperty("--t", "8"));
  await title.dblclick();
  await hold(h, 1000, "half way through the slowed-down title morph");
  await shotPr(h, "subboardcard-entering");
  await page.context().close();
});

/** [[ lists cards inside sub-boards (named after the sub-board, two levels down too) but no pictures or first-line names; the link opens the card there */
test("subboardLinkPicker", async () => {
  const { M, P, S, D } = boards();
  const t = await subHost(M, [P, S, D]), h = t.h, page = h.page;
  await until(h, "the frames show their boards", async () => (await hasBlocks(h, "fPar")) && (await hasBlocks(h, "fSch")));
  await idle(h);
  await verdict("subboardLinkPicker", async (res) => {
    await page.locator('.card[data-id="mNote"] .nbody').dblclick({ position: { x: 300, y: 12 } });
    await page.waitForSelector('.card[data-id="mNote"] .md-pm');
    await page.keyboard.press("ControlOrMeta+End");
    await page.keyboard.type(" [[");
    await page.locator(".md-menu button .lb").first().waitFor();
    const all = await page.locator(".md-menu button .lb").allTextContents();
    res.all = all;
    await shotPr(h, "subboardcard-picker");
    const want = ["异构数据并行计算 › 多核与众核", "异构数据并行计算 › 降低延迟 vs 提高吞吐", "nano-vllm 调度器 › Scheduler.schedule", "nano-vllm 调度器 › Deep › 深处的笔记", "nano-vllm 调度器 › 抢占", "LLMEngine.step", "异构数据并行计算"];
    const banned = ["1. 3", "1. 增加 shape(圆角矩形、圆形等)", "CPU 与 GPU 架构对比", "随手记一句没有标题的话", "Image", "待查：preempt 之后前缀缓存还能命中吗？"];
    res.missing = want.filter((w) => !all.includes(w));
    res.banned = all.filter((x) => banned.some((b) => x === b || x.endsWith(` › ${b}`)));
    await page.keyboard.type("深处");
    await until(h, "the picker narrows to the deep card", async () => (await page.locator(".md-menu button .lb").allTextContents()).join() === "nano-vllm 调度器 › Deep › 深处的笔记");
    await page.keyboard.press("Enter");
    await page.keyboard.press("Escape");
    await until(h, "the link is saved", () => (t.store.peek("bMain")!.cards.find((c) => c.id === "mNote") as NoteCard).md.includes("[[nano-vllm 调度器 › Deep › 深处的笔记]]"));
    await idle(h);
    const chip = page.locator('.card[data-id="mNote"] .md-ref', { hasText: "深处" });
    res.resolved = await chip.evaluate((e) => !e.classList.contains("missing"));
    const n = t.inits.length;
    await chip.click();
    await until(h, "the link opens the deep board", () => t.inits.length > n && t.cur() === "bDeep");
    await until(h, "the card is selected there", () => page.locator('.card.sel[data-id="d1"]').count());
    await idle(h);
    res.crumbs = await page.locator(".crumbs .crumb:not(.back)").allTextContents();
    return !(res.missing as string[]).length && !(res.banned as string[]).length && res.resolved && JSON.stringify(res.crumbs) === JSON.stringify(["Main", "nano-vllm 调度器", "Deep"]);
  });
  await page.context().close();
});

// ---- the map and the previews that open next to the frame (cards/BoardBody.tsx, cards/SubPreviews.tsx, state/subboards.ts) ----

/**
 * Main zoomed out a little and shifted so the frame Parallel, its previews on the right and its title rows below all fit the window.
 * keepBelow: Scheduler stays right under Parallel (the title rows then go to the right); otherwise it is moved out of the way
 */
function setup(o: { keepBelow?: boolean } = {}) {
  const b = boards();
  b.M.cam = { x: -300, y: 60, z: 0.7 };
  if (!o.keepBelow) b.M.place.fSch = { ...b.M.place.fSch, x: 1500, y: 900 };
  return b;
}
const frameSel = (f: string) => `.card[data-id="${f}"]`;
async function ready(h: Host, f: string) {
  await until(h, "the frame draws its map", () => h.page.locator(`${frameSel(f)} .skel [data-sub]`).count());
  await idle(h);
}
async function center(h: Host, sel: string) {
  const b = (await h.page.locator(sel).first().boundingBox())!;
  return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
}
/** Click a block on a frame's map (its middle) and wait for the board to settle */
async function clickBlock(h: Host, f: string, id: string) {
  const c = await center(h, `${frameSel(f)} .skel [data-sub="${id}"] .hit`);
  await h.page.mouse.click(c.x, c.y);
  await idle(h);
}
type PvRow = { id: string; n: string; tit: boolean; mini: boolean; peek: boolean; x: number; y: number; w: number; h: number };
/** The open previews of a frame, in screen px, with the frame's own screen box */
const previews = (h: Host, f: string) => h.page.evaluate((f) => {
  const fr = document.querySelector(`.card[data-id="${f}"]`)!.getBoundingClientRect();
  const rows = [...document.querySelectorAll<HTMLElement>(`.sbpv[data-f="${f}"]`)].map((e) => {
    const r = e.getBoundingClientRect();
    return { id: e.dataset.pv!, n: e.querySelector(".ph i")!.textContent!, tit: e.classList.contains("tit"), mini: e.classList.contains("mini"), peek: e.classList.contains("peek"),
      x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) };
  });
  return { frame: { x: fr.x, y: fr.y, w: fr.width, h: fr.height }, rows };
}, f);
/** Drag from one point to another with the mouse, in steps */
async function drag(h: Host, from: { x: number; y: number }, to: { x: number; y: number }) {
  await h.page.mouse.move(from.x, from.y);
  await h.page.mouse.down();
  await h.page.mouse.move(to.x, to.y, { steps: 10 });
  await h.page.mouse.up();
  await idle(h);
}
/** Wait out the moving previews (they slide to their new places in 160ms) by waiting for their positions to stop changing */
async function settled(h: Host, f: string) {
  let last = "";
  await until(h, "the previews stopped moving", async () => { const s = JSON.stringify((await previews(h, f)).rows); const same = s === last; last = s; return same; });
}

/**
 * The map draws the sub-board as it is: one block per card at its true position and size scaled to fit (same scale for all), sections
 * as regions with their name and count, pictures as thumbnails, code cards with a header band, arrows as lines; no text on the blocks,
 * a tooltip with the card's title on hover
 */
test("subboardMap", async () => {
  const { M, P, S, D } = setup();
  const t = await subHost(M, [P, S, D]), h = t.h, page = h.page;
  await ready(h, "fPar"); await ready(h, "fSch");
  const sk = skeletonOf(P, (id) => t.store.peek(id) as Board | undefined);
  const got = await page.evaluate(() => {
    const f = document.querySelector<HTMLElement>('.card[data-id="fPar"]')!, fr = f.getBoundingClientRect(), z = fr.width / f.offsetWidth;
    const bl = Object.fromEntries([...f.querySelectorAll<SVGGElement>(".skel [data-sub]")].map((g) => {
      const r = g.querySelector(".hit")!.getBoundingClientRect();
      // the hit box is 1px larger than the block on every side
      return [g.dataset.sub!, [(r.x - fr.x) / z + 1, (r.y - fr.y) / z + 1, r.width / z - 2, r.height / z - 2]];
    }));
    return {
      w: f.offsetWidth, h: f.offsetHeight, bl,
      labels: [...f.querySelectorAll(".sblab")].map((l) => `${l.querySelector("span")!.textContent}:${l.querySelector("em")!.textContent}`),
      words: [...f.querySelectorAll(".skel svg text")].length,
      image: !!f.querySelector('.skel [data-sub="pImg"] image'),
      lines: f.querySelectorAll(".skel .ln").length,
    };
  });
  const m = mapFit(sk, got.w, got.h);
  const off = sk.cards.map((c) => {
    const b = got.bl[c.id], want = [m.ox + c.x * m.s, m.oy + c.y * m.s, c.w * m.s, c.h * m.s];
    return b && b.every((v, i) => Math.abs(v - want[i]) < 1) ? "" : `${c.id}: ${b?.map((v) => v.toFixed(1))} vs ${want.map((v) => v.toFixed(1))}`;
  }).filter(Boolean);
  check("subboardMap-blocks", Object.keys(got.bl).length === 18 && sk.cards.length === 18 && !off.length, { n: Object.keys(got.bl).length, off });
  check("subboardMap-sections", JSON.stringify(got.labels) === JSON.stringify(["异构并行计算:6", "数据并行性:3", "CUDA 粗略介绍:2", "以 VectorAdd 为例介绍 Grid, Thread Block, Thread 的基本概念:5"]), got.labels);
  check("subboardMap-look", got.image && got.words === 0, got);
  const sch = await page.evaluate(() => {
    const f = document.querySelector('.card[data-id="fSch"]')!;
    return { codeHead: f.querySelectorAll(".skel .k-code .hd").length, mark: f.querySelectorAll('.skel [data-sub="sMark"] .bar.mk').length, nested: f.querySelectorAll(".skel .k-board").length };
  });
  check("subboardMap-kinds", sch.codeHead === 6 && sch.mark > 0 && sch.nested === 1, sch);
  // hover a block: its title in a tooltip under it
  const c = await center(h, '.card[data-id="fPar"] .skel [data-sub="p9"] .hit');
  await page.mouse.move(c.x, c.y);
  await page.locator(".sbtip").waitFor();
  const tip = await page.evaluate(() => {
    const e = document.querySelector(".sbtip")!, r = e.getBoundingClientRect(), b = document.querySelector('.card[data-id="fPar"] .skel [data-sub="p9"] .hit')!.getBoundingClientRect();
    return { text: e.textContent, below: r.top >= b.bottom, ico: !!e.querySelector(".ico") };
  });
  check("subboardMap-tooltip", tip.text === "CUDA C 程序结构" && tip.below && tip.ico, tip);
  const ic = await center(h, '.card[data-id="fPar"] .skel [data-sub="pImg"] .hit');
  await page.mouse.move(ic.x, ic.y);
  await until(h, "the picture's tooltip", async () => (await page.locator(".sbtip").textContent()) === "CPU 与 GPU 架构对比");
  await shot(h, "subboardMap");
  await page.context().close();
});

/**
 * The map draws each card as tall as it is on its own board, not as estimated: a long Note, a big picture and five square pictures,
 * measured while the sub-board was open, keep their real proportions on the map, and the gap under the long Note its real size
 */
test("subboardMapRealSizes", async () => {
  const B = emptyBoard("bReal", "Real sizes");
  const long = "## CUDA C++ 程序结构\n" + Array.from({ length: 12 }, (_, i) => `第 ${i + 1} 段：主机代码分配显存、拷数据、发射 kernel，设备代码在每个线程里算一个元素。`).join("\n\n");
  B.cards.push(note("rLong", long), { id: "rBig", kind: "image", src: svg(700, 470, "#6091cd"), alt: "大图" }, note("rBelow", "## 下面的卡\n在长 Note 下面"));
  B.place.rLong = { x: 0, y: 0, w: 300 };
  B.place.rBelow = { x: 0, y: 900, w: 300 };
  B.place.rBig = { x: 360, y: 0, w: 700 };
  for (let i = 0; i < 5; i++) {
    B.cards.push({ id: `rSq${i}`, kind: "image", src: svg(236, 236, ["#d77891", "#7aa66b", "#c9a227", "#8a6fc4", "#4aa3a3"][i]), alt: `方图 ${i + 1}` });
    B.place[`rSq${i}`] = { x: 1120 + (i % 3) * 270, y: Math.floor(i / 3) * 330, w: 236 };
  }
  const M = emptyBoard("bMain", "Main");
  M.cards.push({ id: "fReal", kind: "board", board: "bReal" });
  M.place.fReal = { x: 80, y: 80, w: 900, h: 420 };
  M.cam = { x: 0, y: 0, z: 1 };
  const t = await subHost(M, [B]), h = t.h, page = h.page;
  await ready(h, "fReal");
  const ids = B.cards.map((c) => c.id);
  // inside the sub-board: the real sizes (world units)
  const n0 = t.inits.length;
  await page.locator('.card[data-id="fReal"] .sbname').dblclick();
  await until(h, "entering opens the sub-board", () => t.inits.length > n0 && t.cur() === "bReal");
  await idle(h);
  const real = await page.evaluate((ids) => Object.fromEntries(ids.map((id) => { const e = document.querySelector<HTMLElement>(`.card[data-id="${id}"]`)!; return [id, { w: e.offsetWidth, h: e.offsetHeight }]; })), ids);
  await until(h, "the measured heights are saved with the sub-board", () => ids.every((id) => Math.abs((t.store.peek("bReal")!.place[id].mh ?? 0) - real[id].h) <= 8));
  const n1 = t.inits.length;
  await page.keyboard.press("Escape");
  await until(h, "leaving opens Main", () => t.inits.length > n1 && t.cur() === "bMain");
  await ready(h, "fReal");
  await idle(h);
  const map = await page.evaluate((ids) => {
    const f = document.querySelector<HTMLElement>('.card[data-id="fReal"]')!;
    // the hit box is 1px larger than the block on every side
    return Object.fromEntries(ids.map((id) => { const r = f.querySelector(`.skel [data-sub="${id}"] .hit`)!.getBoundingClientRect(); return [id, { x: r.x + 1, y: r.y + 1, w: r.width - 2, h: r.height - 2 }]; }));
  }, ids);
  const off = ids.flatMap((id) => {
    const want = real[id].h / real[id].w, got = map[id].h / map[id].w;
    return Math.abs(got / want - 1) < 0.06 ? [] : [`${id}: drawn ${map[id].w.toFixed(1)}×${map[id].h.toFixed(1)} (h/w ${got.toFixed(2)}), real ${real[id].w}×${real[id].h} (h/w ${want.toFixed(2)})`];
  });
  check("subboardMapRealSizes-proportions", !off.length, off);
  // the gap between the long Note and the card under it, in the board's units
  const k = map.rBig.w / real.rBig.w, gap = (map.rBelow.y - map.rLong.y - map.rLong.h) / k, want = 900 - real.rLong.h;
  check("subboardMapRealSizes-gap", Math.abs(gap - want) < 10, { gap, want });
  await shotPr(h, "subboardcard-real-sizes");
  await page.context().close();
});

/**
 * Clicking blocks opens read-only previews next to the frame, numbered like the badges on their blocks: a Note rendered as Markdown,
 * a code card's highlighted code, a picture with its name; clicking an open block again closes it; the previews follow the frame
 */
test("subboardPreviewOpenClose", async () => {
  const { M, P, S, D } = setup();
  const t = await subHost(M, [P, S, D]), h = t.h, page = h.page;
  await ready(h, "fPar"); await ready(h, "fSch");
  await clickBlock(h, "fPar", "p1");
  await clickBlock(h, "fPar", "pImg");
  await page.locator('.sbpv[data-pv="p1"] .pmd h2').waitFor();
  await page.locator('.sbpv[data-pv="pImg"] img.pimg').waitFor();
  const a = await previews(h, "fPar");
  const note = await page.evaluate(() => {
    const e = document.querySelector('.sbpv[data-pv="p1"]')!, i = document.querySelector('.sbpv[data-pv="pImg"]')!;
    return { title: e.querySelector(".ph span")!.textContent, h2: e.querySelector(".pmd h2")!.textContent, scroll: getComputedStyle(e.querySelector(".pb")!).overflowY,
      cap: i.querySelector(".cap")?.textContent, badges: [...document.querySelectorAll('.card[data-id="fPar"] .sbpick')].map((b) => `${(b as HTMLElement).dataset.pick}:${b.textContent}`) };
  });
  const right = a.rows.every((r) => r.x >= a.frame.x + a.frame.w && !r.tit);
  check("subboardPreviewOpenClose-open", a.rows.length === 2 && right && a.rows.map((r) => r.n).join() === "1,2" && note.title === "多核与众核" && note.h2 === "多核（multicore）与众核（many-core）"
    && note.scroll === "hidden" && note.cap === "CPU 与 GPU 架构对比" && JSON.stringify(note.badges) === JSON.stringify(["p1:1", "pImg:2"]), { a, note });
  // a code card on the other frame: its code, highlighted
  await clickBlock(h, "fSch", t.store.peek("bSch")!.cards.find((c) => c.kind === "code")!.id);
  await page.locator('.sbpv[data-f="fSch"] .pcode .kw').first().waitFor();
  check("subboardPreviewOpenClose-code", /def schedule/.test((await page.locator('.sbpv[data-f="fSch"] .pcode').textContent()) ?? ""));
  // the frame moves: its previews move with it
  const before = (await previews(h, "fPar")).rows[0];
  const name = await center(h, '.card[data-id="fPar"] .sbname');
  await drag(h, name, { x: name.x + 60, y: name.y + 40 });
  await settled(h, "fPar");
  const after = (await previews(h, "fPar")).rows[0];
  check("subboardPreviewOpenClose-follows", Math.abs(after.x - before.x - 60) <= 2 && Math.abs(after.y - before.y - 40) <= 2, { before, after });
  await shot(h, "subboardPreviewOpenClose");
  // the same block again (not a double click: that enters the board) closes its preview; the others renumber
  await hold(h, DBL_CLICK, "the second click on the block must not count as a double click");
  await clickBlock(h, "fPar", "p1");
  const c = await previews(h, "fPar");
  check("subboardPreviewOpenClose-close", c.rows.length === 1 && c.rows[0].id === "pImg" && c.rows[0].n === "1" && t.store.peek("bMain")!.cards.length === M.cards.length, c.rows);
  await page.context().close();
});

/** Up to three previews expand on the right (one column by default, stacked); more open as title rows under the frame, as wide as it */
test("subboardPreviewMaxThree", async () => {
  const { M, P, S, D } = setup();
  const t = await subHost(M, [P, S, D]), h = t.h, page = h.page;
  await ready(h, "fPar");
  for (const id of ["p1", "p2", "p3", "p4", "p5"]) await clickBlock(h, "fPar", id);
  await settled(h, "fPar");
  const s = await previews(h, "fPar");
  const exp = s.rows.filter((r) => !r.tit), tit = s.rows.filter((r) => r.tit);
  const fr = s.frame, z = 0.7;
  check("subboardPreviewMaxThree-split", exp.map((r) => r.id).join() === "p1,p2,p3" && tit.map((r) => r.id).join() === "p4,p5" && s.rows.map((r) => r.n).join() === "1,2,3,4,5", s.rows);
  check("subboardPreviewMaxThree-right", exp.every((r) => r.x >= fr.x + fr.w && Math.abs(r.w - 260 * z) <= 1) && new Set(exp.map((r) => r.x)).size === 1 && exp.every((r, i) => r.y >= fr.y - 1 && (!i || r.y > exp[i - 1].y)), exp);
  check("subboardPreviewMaxThree-titles", tit.every((r) => r.mini && r.y >= fr.y + fr.h && Math.abs(r.h - 30 * z) <= 1 && Math.abs(r.w - 200 * z) <= 1 && r.x >= fr.x - 1 && r.x + r.w <= fr.x + fr.w + 1)
    && tit[0].y === tit[1].y, tit);
  // the bodies never scroll: capped and faded
  const bodies = await page.evaluate(() => [...document.querySelectorAll<HTMLElement>(".sbpv:not(.tit) .pb")].map((b) => ({ h: b.offsetHeight, over: getComputedStyle(b).overflowY })));
  check("subboardPreviewMaxThree-noScroll", bodies.every((b) => b.h <= 170 && b.over === "hidden"), bodies);
  await shot(h, "subboardPreviewMaxThree");
  await page.context().close();
});

/** A title row clicked expands in place, floating over what is below; a click anywhere else folds it back. Hovering a preview draws a dashed line to its block */
test("subboardPreviewPeek", async () => {
  const { M, P, S, D } = setup();
  const t = await subHost(M, [P, S, D]), h = t.h, page = h.page;
  await ready(h, "fPar");
  for (const id of ["p1", "p2", "p3", "p4", "p5", "p7"]) await clickBlock(h, "fPar", id);
  await settled(h, "fPar");
  const before = (await previews(h, "fPar")).rows.find((r) => r.id === "p4")!;
  const c = await center(h, '.sbpv[data-pv="p4"] .ph span');
  await page.mouse.click(c.x, c.y); await idle(h);
  const open = (await previews(h, "fPar")).rows.find((r) => r.id === "p4")!;
  const z = await page.evaluate(() => getComputedStyle(document.querySelector('.sbpv[data-pv="p4"]')!).zIndex);
  check("subboardPreviewPeek-open", open.peek && !open.mini && open.tit && open.x === before.x && open.y === before.y && open.h > before.h * 2 && +z > 4, { before, open, z });
  // hovering it: a dashed line from its block
  check("subboardPreviewPeek-line", (await page.locator(".sbpvl path").count()) === 1);
  await shot(h, "subboardPreviewPeek");
  // a click on the empty board folds it back
  await page.mouse.click(1300, 600); await idle(h);
  const back = (await previews(h, "fPar")).rows.find((r) => r.id === "p4")!;
  check("subboardPreviewPeek-clickAway", back.mini && !back.peek && back.h === before.h, back);
  await page.context().close();
});

/**
 * Dragging a title row to the right expands it where it is dropped (a dashed drop area shows while dragging); the lowest expanded card
 * on the right folds into the first title row. An expanded card dragged down onto the title rows folds into a title row there
 */
test("subboardPreviewDrag", async () => {
  const { M, P, S, D } = setup();
  const t = await subHost(M, [P, S, D]), h = t.h, page = h.page;
  await ready(h, "fPar");
  for (const id of ["p1", "p2", "p3", "p4", "p5"]) await clickBlock(h, "fPar", id);
  await settled(h, "fPar");
  const s0 = await previews(h, "fPar");
  const exp0 = s0.rows.filter((r) => !r.tit);
  // p5's title onto the top of the right area
  const from = await center(h, '.sbpv[data-pv="p5"] .ph span');
  const top = exp0.find((r) => r.id === "p1")!;
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(top.x + 40, top.y + 6, { steps: 10 });
  const area = await page.locator(".sbdrop.on").count();
  await page.mouse.up(); await idle(h); await settled(h, "fPar");
  const s1 = await previews(h, "fPar");
  const exp1 = s1.rows.filter((r) => !r.tit), tit1 = s1.rows.filter((r) => r.tit).sort((a, b) => a.y - b.y || a.x - b.x).map((r) => r.id);
  // dropped above p1: p5 takes the first place (top of the left column)
  const put = exp1.find((r) => r.id === "p5");
  check("subboardPreviewDrag-titleToRight", area === 1 && exp1.length === 3 && !!put && put.x === Math.min(...exp1.map((r) => r.x)) && Math.abs(put.y - s1.frame.y) <= 1
    && ["p1", "p2", "p3"].includes(tit1[0]) && JSON.stringify(tit1.slice(1)) === '["p4"]', { area, exp1, tit1 });
  await shot(h, "subboardPreviewDrag-right");
  // an expanded one (p5) down onto the title rows
  const p5 = await center(h, '.sbpv[data-pv="p5"] .ph span');
  const row = s1.rows.filter((r) => r.tit).sort((a, b) => a.y - b.y || a.x - b.x)[0];
  await page.mouse.move(p5.x, p5.y);
  await page.mouse.down();
  await page.mouse.move(row.x + 30, row.y + 10, { steps: 12 });
  const area2 = await page.locator(".sbdrop.on").count();
  await page.mouse.up(); await idle(h); await settled(h, "fPar");
  const s2 = await previews(h, "fPar");
  const exp2 = s2.rows.filter((r) => !r.tit).map((r) => r.id), tit2 = s2.rows.filter((r) => r.tit);
  check("subboardPreviewDrag-rightToTitles", area2 === 1 && exp2.length === 2 && !exp2.includes("p5") && tit2.some((r) => r.id === "p5" && r.mini && r.y >= s2.frame.y + s2.frame.h), { area2, exp2, tit2 });
  await page.context().close();
});

/** The right area in one column or two (one by default): two columns put the expanded previews side by side, the shorter column first, still at most three; the choice is kept with the frame. Hide / Show and Clear */
test("subboardPreviewColumnsHideClear", async () => {
  const { M, P, S, D } = setup();
  const t = await subHost(M, [P, S, D]), h = t.h, page = h.page;
  await ready(h, "fPar");
  for (const id of ["p1", "p2", "p3", "p4"]) await clickBlock(h, "fPar", id);
  await settled(h, "fPar");
  const acts = '.card[data-id="fPar"] .sbacts';
  const frame = () => t.store.peek("bMain")!.cards.find((c) => c.id === "fPar") as { pcols?: number };
  const one = (await previews(h, "fPar")).rows.filter((r) => !r.tit);
  check("subboardPreviewColumnsHideClear-one", frame().pcols === undefined && one.length === 3 && new Set(one.map((r) => r.x)).size === 1 && one.every((r, i) => !i || r.y > one[i - 1].y)
    && (await page.locator(`${acts} [aria-label="One column"].on`).count()) === 1, one);
  await page.locator(`${acts} [aria-label="Two columns"]`).click(); await idle(h); await settled(h, "fPar");
  const two = (await previews(h, "fPar")).rows;
  const exp = two.filter((r) => !r.tit);
  await until(h, "the choice is saved with the frame", () => frame().pcols === 2);
  check("subboardPreviewColumnsHideClear-two", exp.length === 3 && new Set(exp.map((r) => r.x)).size === 2 && two.filter((r) => r.tit).length === 1, two);
  await shot(h, "subboardPreviewColumns-two");
  check("subboardPreviewColumnsHideClear-label", ((await page.locator(`${acts} .sbfold`).textContent()) ?? "").includes("4 previews · Hide"));
  await page.locator(`${acts} .sbfold`).click(); await idle(h);
  const folded = await page.evaluate(() => { const e = document.querySelector<HTMLElement>('.sbpvs[data-f="fPar"]')!; return { cls: e.classList.contains("folded"), pe: getComputedStyle(e).pointerEvents }; });
  check("subboardPreviewColumnsHideClear-hide", folded.cls && folded.pe === "none" && ((await page.locator(`${acts} .sbfold`).textContent()) ?? "").includes("Show"), folded);
  await page.locator(`${acts} .sbfold`).click(); await idle(h);
  check("subboardPreviewColumnsHideClear-show", !(await page.locator('.sbpvs[data-f="fPar"].folded').count()) && (await page.locator('.sbpv[data-f="fPar"]').count()) === 4);
  await page.locator(`${acts} .sbclr`).click(); await idle(h);
  check("subboardPreviewColumnsHideClear-clear", (await page.locator('.sbpv[data-f="fPar"]').count()) === 0 && (await page.locator(acts).count()) === 0 && (await page.locator('.card[data-id="fPar"] .sbpick').count()) === 0);
  await clickBlock(h, "fPar", "p1");
  await page.locator(`${acts} [aria-label="One column"]`).click(); await idle(h);
  await until(h, "one column again", () => frame().pcols === undefined);
  await page.context().close();
});

/** Screen boxes of everything on Main other than frame f: cards, and sub-board frames with the name above them */
const others = (h: Host, f: string) => h.page.evaluate((f) => [...document.querySelectorAll<HTMLElement>(".world > .card")].filter((c) => c.dataset.id !== f).flatMap((c) => {
  const r = c.getBoundingClientRect(), n = c.querySelector(".sbname")?.getBoundingClientRect();
  return [{ id: c.dataset.id!, x: r.x, y: r.y, w: r.width, h: r.height }, ...(n ? [{ id: `${c.dataset.id} name`, x: n.x, y: n.y, w: n.width, h: n.height }] : [])];
}), f);
const overlap = (a: { x: number; y: number; w: number; h: number }, b: { x: number; y: number; w: number; h: number }) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

/**
 * Title rows never cover what sits under the frame: with the next sub-board frame right below (its name in the way) they line up on
 * the right under the expanded previews; once the space under the frame is clear they go back under it. The rule holds while the frame is dragged
 */
test("subboardPreviewTitlesAvoidCards", async () => {
  const { M, P, S, D } = setup({ keepBelow: true });
  const t = await subHost(M, [P, S, D]), h = t.h, page = h.page;
  await ready(h, "fPar");
  for (const id of ["p1", "p2", "p3", "p4", "p5"]) await clickBlock(h, "fPar", id);
  await settled(h, "fPar");
  const covered = async () => { const s = await previews(h, "fPar"), o = await others(h, "fPar"); return s.rows.flatMap((r) => o.filter((b) => overlap(r, b)).map((b) => `${r.id} on ${b.id}`)); };
  const a = await previews(h, "fPar");
  const exp = a.rows.filter((r) => !r.tit), tit = a.rows.filter((r) => r.tit);
  const bottom = Math.max(...exp.map((r) => r.y + r.h));
  check("subboardPreviewTitlesAvoidCards-side", tit.length === 2 && tit.every((r) => r.mini && r.x >= a.frame.x + a.frame.w && r.y >= bottom) && !(await covered()).length, { tit, bottom, covered: await covered() });
  await shot(h, "subboardPreviewTitlesAvoidCards-side");
  // Scheduler dragged away by its name: the title rows come back under Parallel
  const n = await center(h, '.card[data-id="fSch"] .sbname');
  await drag(h, n, { x: n.x + 750, y: n.y + 200 });
  await settled(h, "fPar");
  const b = await previews(h, "fPar");
  check("subboardPreviewTitlesAvoidCards-below", b.rows.filter((r) => r.tit).every((r) => r.y >= b.frame.y + b.frame.h && r.x < b.frame.x + b.frame.w) && !(await covered()).length, { rows: b.rows, covered: await covered() });
  // Parallel dragged down onto the Note column's level: wherever it stops, nothing is covered
  const pn = await center(h, '.card[data-id="fPar"] .sbname');
  await drag(h, pn, { x: pn.x - 120, y: pn.y + 330 });
  await settled(h, "fPar");
  check("subboardPreviewTitlesAvoidCards-dragged", !(await covered()).length, await covered());
  await page.context().close();
});

/**
 * A Note named by its leading heading shows that heading once, in the preview's title row, not again in the body (the same rule and
 * setting as Note cards on the board: Settings → Notes keeps it in the body); a Note with its own name keeps its heading in the body
 */
test("subboardPreviewNoteHeading", async () => {
  const { M, P, S, D } = setup();
  const t = await subHost(M, [P, S, D]), h = t.h, page = h.page;
  await ready(h, "fPar");
  await clickBlock(h, "fPar", "p2");
  await clickBlock(h, "fPar", "p1");
  await page.locator('.sbpv[data-pv="p2"] .pmd h2').waitFor({ state: "attached" });
  const read = () => page.evaluate(() => {
    const one = (id: string) => { const e = document.querySelector(`.sbpv[data-pv="${id}"]`)!, h2 = e.querySelector<HTMLElement>(".pmd h2");
      return { title: e.querySelector(".ph span")!.textContent, h2: h2 && h2.offsetHeight > 0 ? h2.textContent : null, text: e.querySelector(".pmd")!.textContent }; };
    return { p2: one("p2"), p1: one("p1") };
  });
  const r = await read();
  check("subboardPreviewNoteHeading-once", r.p2.title === "降低延迟 vs 提高吞吐" && r.p2.h2 === null && /两种不同的设计目标/.test(r.p2.text ?? ""), r.p2);
  check("subboardPreviewNoteHeading-ownTitle", r.p1.title === "多核与众核" && r.p1.h2 === "多核（multicore）与众核（many-core）", r.p1);
  await h.post({ type: "host", host: { settings: { ...DEFAULT_SETTINGS, noteHeadingInBody: true } } });
  await until(h, "the setting shows the heading in the body", async () => (await read()).p2.h2 === "降低延迟 vs 提高吞吐");
  await page.context().close();
});
