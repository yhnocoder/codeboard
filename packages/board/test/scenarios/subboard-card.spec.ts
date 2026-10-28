import * as fs from "node:fs";
import * as path from "node:path";
import { DEFAULT_SETTINGS, emptyBoard, type NoteCard } from "@codeboard/core";
import { put, symCard, findSym, shot, OUT, type Host } from "../harness";
import { subHost } from "../subhost";
import { test, until, idle, hold, verdict, check } from "../fixtures";
import { WHEEL_GESTURE } from "../../src/state/timing";

const nv = (qual: string) => { const s = findSym(qual); return symCard(s.f, s.s); };
const note = (id: string, md: string, o: Partial<NoteCard> = {}): NoteCard => ({ id, kind: "note", md, bg: true, ...o });
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
  S.cards.push(note("sMark", "待查：preempt 之后前缀缓存还能命中吗？", { bg: false, hand: "orange" }));
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
const hasMinis = (h: Host, frame: string) => h.page.locator(`.card[data-id="${frame}"] .mini`).count();

/**
 * In the page: a frame's built columns, each with its mini cards grouped into stacks (by their left edge), in world px at zoom 1
 * (the positions BoardBody writes). fill = how far each mini card's height is off its content (last line + bottom padding), so a
 * gap computed from the positions is also the gap you see
 */
function geometry(id: string) {
  const f = document.querySelector<HTMLElement>(`.card[data-id="${id}"]`)!, cols = f.querySelector<HTMLElement>(".sbcols")!;
  const px = (v: string) => parseFloat(v) || 0;
  const minis = [...cols.querySelectorAll<HTMLElement>(".mini")].map((m) => {
    const last = m.lastElementChild as HTMLElement | null;
    return { id: m.dataset.sub!, x: px(m.style.left), y: px(m.style.top), w: px(m.style.width), h: px(m.style.height), rw: m.offsetWidth, more: m.matches(".k-more"),
      fill: last && !m.matches(".k-more") ? Math.abs(last.offsetTop + last.offsetHeight + px(getComputedStyle(m).paddingBottom) - m.offsetHeight) : 0 };
  });
  return [...cols.querySelectorAll<HTMLElement>(".sbcol")].map((c) => {
    const x = px(c.style.left), w = px(c.style.width), n = +c.querySelector("em")!.textContent!;
    const mine = minis.filter((m) => m.x >= x && m.x < x + w);
    const stacks = [...new Set(mine.map((m) => m.x))].sort((a, b) => a - b).map((sx) => mine.filter((m) => m.x === sx).sort((a, b) => a.y - b.y));
    return { t: c.querySelector("span")!.textContent!, n, x, w, fw: cols.offsetWidth, top: c.offsetTop, h: c.offsetHeight, stacks };
  });
}
type Geo = ReturnType<typeof geometry>;
/** Masonry: 3 or fewer cards one stack, 4 or more two; in a stack each card starts exactly MINI_GAP (6) below the one above; heights match content */
function masonryOk(g: Geo) {
  const bad: string[] = [];
  for (const c of g) {
    // a stack that starts past the frame's right edge isn't built
    const want = c.n <= 3 ? 1 : 2, inside = [0, 1].slice(0, want).filter((k) => c.x + k * 130 < c.fw).length;
    if (c.stacks.length !== inside) bad.push(`${c.t}: ${c.stacks.length} stacks for ${c.n} cards`);
    if (Math.abs(c.w - (want * 124 + (want - 1) * 6)) > 0.01) bad.push(`${c.t}: width ${c.w}`);
    for (const st of c.stacks) {
      st.forEach((m, i) => {
        if (m.fill > 1.5) bad.push(`${m.id}: ${m.fill}px between its content and its edge`);
        if (i && Math.abs(m.y - (st[i - 1].y + st[i - 1].h) - 6) > 0.01) bad.push(`${m.id}: ${(m.y - st[i - 1].y - st[i - 1].h).toFixed(1)}px below ${st[i - 1].id}`);
      });
    }
  }
  return bad;
}

/** The columns the frame has room for (name + count), mini cards at one fixed size whatever the frame's size, in masonry stacks, no arrows; Warm Ink */
test("subboardColumns", async () => {
  const { M, P, S, D } = boards();
  M.place.fSch.w = 560; // a narrower frame: the mini cards keep their size; its two two-stack columns just fit, so only the wide one fades out
  const t = await subHost(M, [P, S, D]), h = t.h, page = h.page;
  await until(h, "both frames show their boards", async () => (await hasMinis(h, "fPar")) && (await hasMinis(h, "fSch")));
  await idle(h);
  await verdict("subboardColumns", async (res) => {
    const r = await page.evaluate(() => {
      const frame = (id: string) => document.querySelector<HTMLElement>(`.card[data-id="${id}"]`)!;
      const par = frame("fPar"), sch = frame("fSch");
      const minis = (f: HTMLElement) => [...f.querySelectorAll<HTMLElement>(".mini")];
      const font = (f: HTMLElement) => [...new Set(minis(f).filter((m) => !m.matches(".sticky, .k-more, .k-code")).map((m) => getComputedStyle(m.querySelector(".ti")!).fontSize))];
      const ms = minis(par);
      return {
        look: document.documentElement.dataset.look,
        cols: [...par.querySelectorAll(".sbcol")].map((c) => `${c.querySelector("span")!.textContent}:${c.querySelector("em")!.textContent}`),
        widths: [...new Set([...ms, ...minis(sch)].map((m) => m.offsetWidth))],
        fonts: [...new Set([...font(par), ...font(sch)])],
        arrows: [par, sch].reduce((n, f) => n + f.querySelectorAll(".sbcols svg:not(.ico)").length, 0),
        image: !!par.querySelector('.mini[data-sub="pImg"] img.thumb'),
        code: sch.querySelector(".mini.k-code .sub")?.textContent,
        codeSrc: sch.querySelector(".mini.k-code .src span")?.textContent,
        sticky: !!sch.querySelector('.mini.sticky[data-sub="sMark"]'),
        summary: par.querySelector('.mini[data-sub="p2"] .sub')?.textContent,
        fade: par.querySelector(".sbcols")!.classList.contains("fade-r") && !sch.querySelector(".sbcols")!.classList.contains("fade-r"),
        overlap: ms.some((a, i) => ms.some((b, j) => j > i && a.offsetLeft < b.offsetLeft + b.offsetWidth && b.offsetLeft < a.offsetLeft + a.offsetWidth && a.offsetTop < b.offsetTop + b.offsetHeight && b.offsetTop < a.offsetTop + a.offsetHeight)),
      };
    });
    Object.assign(res, r);
    const par = await page.evaluate(geometry, "fPar"), sch = await page.evaluate(geometry, "fSch");
    res.stacks = [...par, ...sch].map((c) => `${c.t.slice(0, 6)}:${c.n}:${c.stacks.map((s) => s.length).join("+")}`);
    res.masonry = [...masonryOk(par), ...masonryOk(sch)];
    await shotPr(h, "subboardcard-columns");
    // 620 wide: three section columns start inside the frame (two of two stacks, one of one); the rest would start past its right edge and aren't built
    return r.look === "warm-ink" && JSON.stringify(r.cols) === JSON.stringify(["异构并行计算:6", "以 VectorAdd 为例介绍 Grid, Thread Block, Thread 的基本概念:5", "数据并行性:3"])
      && r.widths.length === 1 && r.widths[0] === 124 && r.fonts.length === 1 && r.arrows === 0 && r.image && r.code === "lines 25–73" && r.codeSrc === "scheduler.py" && r.sticky
      && r.summary === "两种不同的设计目标" && r.fade && !r.overlap && !(res.masonry as string[]).length
      && JSON.stringify(par.map((c) => c.stacks.length)) === "[2,2,1]" && JSON.stringify(sch.map((c) => c.stacks.length)) === "[2,2]";
  });
  await page.context().close();
});

/** The board's name and card count sit above the frame, outside it; with Sub-board Preview = Title Only the frame draws no mini cards */
test("subboardTitleAboveFrame", async () => {
  const { M, P, S, D } = boards();
  const t = await subHost(M, [P, S, D]), h = t.h, page = h.page;
  await until(h, "the frame shows its board", () => hasMinis(h, "fSch"));
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
  await until(h, "Title Only drops the mini cards", async () => (await hasMinis(h, "fSch")) === 0);
  await idle(h);
  const only = await title();
  check("subboardTitleAboveFrame-titleOnly", only.above && only.hit && only.name === "nano-vllm 调度器" && only.count === "9", only);
  await page.context().close();
});

/**
 * A sub-board of 240 cards: the frame builds only the mini cards that start inside it (the cut ones under the fade too), and more
 * once it is made bigger; resizing only reveals more: the mini cards already shown keep their size and place
 */
test("subboardDrawsOnlyWhatFits", async () => {
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
  await until(h, "the frame shows its board", () => hasMinis(h, "fBig"));
  await idle(h);
  const drawn = () => frame.evaluate((f) => {
    const cols = f.querySelector<HTMLElement>(".sbcols")!, w = cols.clientWidth, hh = cols.clientHeight;
    const ms = [...cols.querySelectorAll<HTMLElement>(".mini")];
    return {
      n: ms.length, w, h: hh,
      inside: ms.every((m) => m.offsetLeft < w && m.offsetTop < hh),
      // what is built reaches past the right and bottom edges: nothing that shows is missing
      reachR: Math.max(...ms.map((m) => m.offsetLeft + m.offsetWidth)) >= w, reachB: Math.max(...ms.map((m) => m.offsetTop + m.offsetHeight)) >= hh,
      count: f.querySelector(".sbmeta")?.textContent,
      boxes: Object.fromEntries(ms.map((m) => [m.dataset.sub!, `${m.style.left},${m.style.top},${m.offsetWidth}x${m.offsetHeight}`])),
    };
  });
  const small = await drawn();
  // 500 × 300: two columns of two stacks start inside, four cards deep each (a card is about 63px tall)
  check("subboardDrawsOnlyWhatFits-small", small.count === "240" && small.n > 0 && small.n <= 16 && small.inside && small.reachR && small.reachB, { ...small, boxes: undefined });
  const geoSmall = await page.evaluate(geometry, "fBig");
  check("subboardDrawsOnlyWhatFits-masonry", JSON.stringify(geoSmall.map((c) => c.stacks.length)) === "[2,2]" && !masonryOk(geoSmall).length, masonryOk(geoSmall));
  // bigger with its corner grip: more mini cards, still only those that start inside it
  await frame.click({ position: { x: 250, y: 150 } }); await idle(h);
  const grip = (await frame.locator(".grip").boundingBox())!;
  await page.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2);
  await page.mouse.down();
  await page.mouse.move(grip.x + 300, grip.y + 200, { steps: 8 });
  await page.mouse.up();
  await idle(h);
  const big = await drawn();
  check("subboardDrawsOnlyWhatFits-bigger", big.w > small.w && big.h > small.h && big.n > small.n && big.n <= 42 && big.inside && big.reachR && big.reachB, { ...big, boxes: undefined });
  const moved = Object.entries(small.boxes).filter(([id, b]) => big.boxes[id] !== b).map(([id, b]) => `${id}: ${b} → ${big.boxes[id]}`);
  check("subboardDrawsOnlyWhatFits-noRelayout", !moved.length && Object.values(big.boxes).every((b) => b.split(",")[2].startsWith("124x")), moved);
  await page.context().close();
});

/**
 * The design's sub-board card (feedback demo #12, option B2: 600 × 340, three sections of seven cards) rebuilt on a board at zoom
 * 100%: the title 16px above the frame, the columns, their headers, the mini cards' sizes and text, the sticky note and the masonry
 * stacks land where the demo puts them (its numbers, measured in Chromium). A picture of it is the board half of 12-demo-vs-board
 */
test("subboardMatchesDemo", async () => {
  const B = emptyBoard("bDemo", "nano-vllm 调度器");
  B.sections.push({ id: "sch", title: "Scheduler：每一步挑哪些序列", x: 0, y: 0, w: 760, h: 560, color: "sand" });
  B.sections.push({ id: "bm", title: "BlockManager：KV cache 按块分配", x: 820, y: 0, w: 620, h: 560, color: "blue" });
  B.sections.push({ id: "mr", title: "ModelRunner：把一批序列跑一步", x: 0, y: 620, w: 1440, h: 400, color: "green" });
  // the demo's cards, at its positions (which set the reading order): [id or symbol, section, x, y, note text]
  const cards: [string, string, number, number, string?][] = [
    ["LLMEngine.step", "sch", 30, 50], ["Scheduler.schedule", "sch", 340, 50], ["n3", "sch", 30, 240, "## 先 prefill，后 decode\nwaiting 队列优先，凑满 max_num_batched_tokens"],
    ["Scheduler.preempt", "sch", 340, 350], ["n5", "sch", 30, 350, "## 抢占：显存不够就把最后一个踢回 waiting\n释放它的块，之后重新 prefill"],
    ["Scheduler.postprocess", "sch", 30, 460], ["n7", "sch", 640, 350, "待查：preempt 之后前缀缓存还能命中吗？"],
    ["BlockManager.can_allocate", "bm", 850, 50], ["BlockManager.allocate", "bm", 850, 200], ["b3", "bm", 1160, 50, "## 前缀缓存：按块算 hash\ncompute_hash(token_ids, prefix) 一块接一块链起来"],
    ["BlockManager.compute_hash", "bm", 1160, 160], ["BlockManager.may_append", "bm", 850, 410], ["b6", "bm", 1160, 300, "## ref_count 为 0 才真正释放\n共享前缀的块会被多个序列引用"],
    ["BlockManager.deallocate", "bm", 1160, 420],
    ["ModelRunner.run", "mr", 30, 670], ["ModelRunner.prepare_prefill", "mr", 330, 670], ["ModelRunner.prepare_decode", "mr", 670, 670], ["ModelRunner.run_model", "mr", 990, 670],
    ["m5", "mr", 990, 830, "## decode 走 CUDA Graph\nbatch 不大时重放事先录好的图"], ["ModelRunner.capture_cudagraph", "mr", 670, 860],
    ["m7", "mr", 30, 830, "## slot_mapping：每个 token 写进 KV cache 的哪一格\nprepare_prefill 和 prepare_decode 都要算"],
  ];
  for (const [k, sec, x, y, md] of cards) {
    const c = md === undefined ? nv(k) : note(k, md, k === "n7" ? { bg: false, hand: "orange" } : {});
    put(B, c, x, y, 260); B.place[c.id].section = sec;
  }
  // Main: the demo's stage (a note and LLMEngine.step pointing at the frame), 40px in from the top left
  const M = emptyBoard("bMain", "Main");
  M.cards.push(note("n12", "显存不够时 `can_allocate` 返回 False，调度器就会 `preempt` 最后一个序列。"));
  M.place.n12 = { x: 64, y: 104, w: 272 };
  const step = nv("LLMEngine.step");
  put(M, step, 64, 276, 300);
  M.cards.push({ id: "fDemo", kind: "board", board: "bDemo" });
  M.place.fDemo = { x: 420, y: 110, w: 600, h: 340 };
  M.links.push({ id: "L1", from: { card: "n12" }, to: { card: "fDemo" } }, { id: "L2", from: { card: step.id }, to: { card: "fDemo" } });
  M.cam = { x: 0, y: 0, z: 1 };
  // the demo is light Warm Ink: so is this board, whatever HARNESS_LIGHT says
  const t = await subHost(M, [B], { light: true }), h = t.h, page = h.page;
  await until(h, "the frame shows its board", () => hasMinis(h, "fDemo"));
  await idle(h);
  const r = await page.evaluate(() => {
    const f = document.querySelector<HTMLElement>('.card[data-id="fDemo"]')!, fr = f.getBoundingClientRect();
    const box = (sel: string) => { const e = f.querySelector(sel); if (!e) return null; const b = e.getBoundingClientRect(); return [b.left - fr.left, b.top - fr.top, b.width, b.height].map((v) => +v.toFixed(1)); };
    const css = (sel: string, ...ks: string[]) => { const e = f.querySelector(sel); if (!e) return null; const s = getComputedStyle(e); return ks.map((k) => s.getPropertyValue(k)).join(" "); };
    const T = ["font-size", "font-weight", "line-height", "color"];
    return {
      zoom: fr.width / f.offsetWidth, frame: [fr.width, fr.height], radius: getComputedStyle(f).borderRadius,
      name: box(".sbname"), count: box(".sbmeta"),
      nameCss: css(".sbname", ...T, "letter-spacing"), countCss: css(".sbmeta", ...T),
      h4: box(".sbcol"), h4Css: css(".sbcol", ...T), emCss: css(".sbcol em", ...T),
      bar: getComputedStyle(f.querySelector(".sbcol")!, "::before").backgroundColor,
      code: css(".mini.k-code", "padding", "border-radius", "background-color", "box-shadow"),
      src: css(".mini.k-code .src", ...T), ico: box(".mini.k-code .src .ico"),
      codeTi: css(".mini.k-code .ti", ...T, "letter-spacing"), codeSub: css(".mini.k-code .sub", ...T),
      noteTi: css(".mini.k-note:not(.sticky) .ti", ...T), noteSub: css(".mini.k-note:not(.sticky) .sub", ...T),
      sticky: css(".mini.sticky", "background-color", "box-shadow", "border-radius"), stickySrc: css(".mini.sticky .src", "color"),
      stickyIco: !!f.querySelector(".mini.sticky .src .ico"), stickyTi: css(".mini.sticky .ti", ...T, "-webkit-line-clamp"),
      mask: css(".sbcols", "mask-image"), maskCls: f.querySelector(".sbcols")?.className,
      rect: [fr.left, fr.top, fr.width, fr.height],
    };
  });
  const g = await page.evaluate(geometry, "fDemo");
  const titles: Record<string, string> = Object.fromEntries(await page.locator('.card[data-id="fDemo"] .mini').evaluateAll((ms) => ms.map((m) => [(m as HTMLElement).dataset.sub!, m.querySelector(".ti")!.textContent!])));
  const stacks = g.map((c) => c.stacks.map((s) => s.map((m) => titles[m.id])));
  const near = (a: number[] | null, b: number[]) => !!a && a.length === b.length && a.every((v, i) => Math.abs(v - b[i]) <= 0.6);
  // demo numbers (feedback-demo.html #12 B2, Warm Ink, zoom 100%), relative to the frame's top left
  check("subboardMatchesDemo-frame", r.zoom === 1 && r.frame.join() === "600,340" && r.radius === "22px", r);
  check("subboardMatchesDemo-title", !!r.name && !!r.count && near(r.name, [6, -46, r.name[2], 30]) && near(r.count, [r.name[0] + r.name[2] + 10, -46, r.count[2], 30])
    && r.nameCss === "25px 700 30px rgb(33, 31, 27) -0.375px" && r.countCss === "25px 500 30px rgb(154, 149, 139)", { name: r.name, count: r.count, nameCss: r.nameCss, countCss: r.countCss });
  check("subboardMatchesDemo-columns", JSON.stringify(g.map((c) => [c.x, c.w])) === "[[18,254],[288,254],[558,254]]" && near(r.h4, [18, 18, 254, 32.4])
    && r.h4Css === "12px 600 16.2px rgb(33, 31, 27)" && r.emCss === "11px 500 14.85px rgb(154, 149, 139)" && r.bar === "rgba(206, 170, 110, 0.16)"
    && g.every((c) => c.stacks.every((s) => Math.abs(s[0].y - 39.4) < 0.01)), { cols: g.map((c) => [c.t, c.x, c.w, c.stacks[0]?.[0]?.y]), h4: r.h4, h4Css: r.h4Css, emCss: r.emCss, bar: r.bar });
  check("subboardMatchesDemo-mini", r.code === "7px 8px 8px 8px rgb(253, 252, 250) rgba(60, 45, 20, 0.16) 0px 0px 0px 0.5px, rgba(50, 35, 10, 0.05) 0px 1px 2px 0px"
    && r.src === "10px 400 12px rgb(154, 149, 139)" && !!r.ico && near(r.ico, [26, r.ico[1], 11, 11])
    && r.codeTi === "11px 600 14.85px rgb(33, 31, 27) -0.11px" && r.codeSub === "10px 400 13.5px rgb(154, 149, 139)"
    && r.noteTi === "11.5px 600 15.525px rgb(33, 31, 27)" && r.noteSub === "10.5px 400 14.175px rgb(98, 94, 86)", r);
  check("subboardMatchesDemo-sticky", r.sticky === "rgb(251, 239, 182) rgba(150, 110, 20, 0.2) 0px 0px 0px 0.5px 8px" && r.stickySrc === "rgb(138, 106, 22)" && !r.stickyIco
    && r.stickyTi === "11.5px 500 15.525px rgb(74, 60, 18) 4", { sticky: r.sticky, src: r.stickySrc, ico: r.stickyIco, ti: r.stickyTi });
  check("subboardMatchesDemo-fade", r.mask === "linear-gradient(to right, rgb(0, 0, 0) calc(100% - 44px), rgba(0, 0, 0, 0)), linear-gradient(rgb(0, 0, 0) calc(100% - 40px), rgba(0, 0, 0, 0))", [r.mask, r.maskCls]);
  // the masonry rule, not the demo's exact stacks: which stack a card lands in follows the measured heights, and those follow how the
  // installed fonts wrap the CJK titles (CI's fonts wrap differently from the machine the demo was measured on). The third column's
  // second stack starts past the frame's right edge, so it isn't built
  check("subboardMatchesDemo-masonry", !masonryOk(g).length && JSON.stringify(g.map((c) => c.stacks.length)) === "[2,2,1]"
    && JSON.stringify(stacks.map((c) => c.flat().length)) === "[7,7,4]", { stacks, bad: masonryOk(g) });
  await shotPr(h, "subboardcard-demo");
  // the frame with its title and a margin: the board half of the side-by-side picture
  const [x, y, w, hh] = r.rect;
  await page.screenshot({ path: path.join(OUT, "subboardcard-demo-frame.png"), clip: { x: x - 24, y: y - 60, width: w + 48, height: hh + 84 } });
  await page.context().close();
});

/** The wheel over a sub-board card pans the board, selected or not: nothing in the frame scrolls */
test("subboardWheelPansBoard", async () => {
  const { M, P, S, D } = boards();
  const t = await subHost(M, [P, S, D]), h = t.h, page = h.page;
  await until(h, "the frame shows its columns", () => hasMinis(h, "fPar"));
  await idle(h);
  const cam = () => page.evaluate(() => document.querySelector<HTMLElement>(".world")!.style.transform);
  const cols = page.locator('.card[data-id="fPar"] .skel');
  await verdict("subboardWheelPansBoard", async (res) => {
    const c0 = await cam();
    const box = (await cols.boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.wheel(120, 0); await idle(h);
    res.unselectedPans = (await cam()) !== c0;
    // select the frame (its name), then a new gesture over its columns
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

/** An arrow dragged from a card's port onto a mini card inside the frame attaches to the frame itself: the frame lights up, the arrowhead is on its edge */
test("subboardLinkAttachesToFrame", async () => {
  const { M, P, S, D } = boards();
  const t = await subHost(M, [P, S, D]), h = t.h, page = h.page;
  await until(h, "the frame shows its columns", () => hasMinis(h, "fSch"));
  await idle(h);
  await verdict("subboardLinkAttachesToFrame", async (res) => {
    const nb = (await page.locator('.card[data-id="mNote"]').boundingBox())!;
    await page.mouse.move(nb.x + nb.width / 2, nb.y + nb.height / 2); await idle(h);
    const port = (await page.locator('.card[data-id="mNote"] .eport.r').boundingBox())!;
    const mini = (await page.locator('.card[data-id="fSch"] .mini[data-sub]').first().boundingBox())!;
    await page.mouse.move(port.x + port.width / 2, port.y + port.height / 2);
    await page.mouse.down();
    await page.mouse.move(mini.x + mini.width / 2, mini.y + mini.height / 2, { steps: 10 });
    res.frameHot = await page.locator('.card.drop-hot[data-id="fSch"]').count();
    res.miniHot = await page.locator(".mini.hot").count();
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
    // the head sits on the frame's outline, not on a mini card inside it
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
  await until(h, "the frame shows its columns", () => hasMinis(h, "fPar"));
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
  await until(h, "the frames show their boards", async () => (await hasMinis(h, "fPar")) && (await hasMinis(h, "fSch")));
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
