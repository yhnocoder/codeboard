// Definition peek on hover, with ⌘ held and on keywords:
//  cmdHeldBeforeHoverShowsOnePeek   ⌘ held down before the mouse reaches the code (with the key's auto-repeat keydowns), then the mouse
//                                   wiggles on a name, moves to another name and sweeps a line: never more than one peek at a time,
//                                   none pinned. A fresh ⌘ press on a shown peek still pins it
//  cudaKeywordNotPeekable           CUDA / C++ qualifiers and keywords (__global__, __shared__, static_cast) and Rust keywords get no peek
//                                   and no lookup; a name on the same line does
//  peekNoDefNamesLanguageExtension  "No definition found" gives the reason for the card's language: C/C++/CUDA name clangd or
//                                   ms-vscode.cpptools, Rust rust-analyzer, Python keeps setattr / the Python extension
import { emptyBoard, type Board, type CodeCard } from "@codeboard/core";
import { put, symCard, findSym, shot, type Host } from "../harness";
import { test, open, check, light, until, idle, hold, expect } from "../fixtures";
import { PEEK_DELAY } from "../../src/state/timing";

const free = (id: string, lang: string, text: string[], title: string): CodeCard =>
  ({
    id,
    kind: "code",
    title,
    segments: [
      {
        id: `s${id}`,
        src: { kind: "free" },
        path: "",
        lang,
        start: 1,
        end: text.length,
        text: text.slice(),
        version: { kind: "none" },
      },
    ],
  }) as CodeCard;

const CUDA = [
  "__global__ void rgb_to_grayscale(const unsigned char* rgb, unsigned char* gray, int n) {",
  "    __shared__ float tile[256];",
  "    int i = blockIdx.x * blockDim.x + threadIdx.x;",
  "    if (i < n) gray[i] = static_cast<unsigned char>(0.299f * rgb[3 * i] + 0.587f * rgb[3 * i + 1]);",
  "}",
];
const RUST = ["pub fn frobnicate(x: u32) -> u32 {", "    let y = x + 1;", "    y", "}"];
const PY = ["def handler(obj):", "    return obj.unknown_attr_xyz()"];

/** Middle of `word` on the line containing `line`, in the card whose header contains `card` */
async function wordAt(h: Host, card: string, line: string, word: string): Promise<{ x: number; y: number }> {
  const pt = await h.page.evaluate(
    ([card, line, word]) => {
      for (const c of document.querySelectorAll(".card")) {
        if (!c.querySelector(".chead")?.textContent?.includes(card)) continue;
        for (const l of c.querySelectorAll(".src .l")) {
          const t = l.textContent ?? "";
          const i = t.indexOf(line);
          if (i < 0) continue;
          const at = i + line.indexOf(word) + Math.floor(word.length / 2);
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
  if (!pt) throw new Error(`wordAt: ${word} in ${line} not found`);
  return pt;
}

/** Records, on every DOM change, the most peeks and pinned peeks there ever were at once */
const watchPeeks = (h: Host) =>
  h.page.evaluate(() => {
    const w = window as unknown as { peekMax: number; pinMax: number };
    w.peekMax = 0;
    w.pinMax = 0;
    const look = () => {
      w.peekMax = Math.max(w.peekMax, document.querySelectorAll(".pop.k-peek").length);
      w.pinMax = Math.max(w.pinMax, document.querySelectorAll(".pop.k-peek .pinned").length);
    };
    new MutationObserver(look).observe(document.body, { childList: true, subtree: true });
    look();
  });
const peekStats = (h: Host) =>
  h.page.evaluate(() => {
    const w = window as unknown as { peekMax: number; pinMax: number };
    return {
      max: w.peekMax,
      pinnedMax: w.pinMax,
      now: document.querySelectorAll(".pop.k-peek").length,
      pinnedNow: document.querySelectorAll(".pop.k-peek .pinned").length,
    };
  });

test("cmdHeldBeforeHoverShowsOnePeek", async () => {
  const b = emptyBoard("b1", "board");
  const s = findSym("Scheduler.schedule");
  const sch = symCard(s.f, s.s);
  put(b, sch, 60, 40, 760);
  b.cam = { x: 0, y: 0, z: 1 };
  const h = await open({ board: b, light, w: 1300, h: 900 });
  await idle(h);
  await watchPeeks(h);
  const samples: number[] = [];
  const sample = async () => samples.push(await h.page.locator(".pop.k-peek").count());
  const title = () => h.page.locator(".pop.k-peek .pt").first().textContent();

  // ⌘ goes down while the mouse is still off the card; holding a key repeats its keydown (repeat: true), which the sweep sends too
  await h.page.mouse.move(5, 5);
  await h.page.keyboard.down("Meta");
  const a = await wordAt(h, "schedule", "self.block_manager.can_allocate(seq)", "can_allocate");
  await h.page.mouse.move(a.x - 3, a.y);
  await h.page.mouse.move(a.x, a.y, { steps: 2 });
  await h.page.keyboard.down("Meta");
  await h.page.locator(".pop.k-peek .pt").waitFor();
  await idle(h); // PEEK_DELAY after the hover, filled from the host
  const first = await title();
  // wiggle on the same name, ⌘ still held (and repeating)
  for (let i = 0; i < 12; i++) {
    await h.page.mouse.move(a.x + (i % 3) - 1, a.y + (i % 2));
    if (i % 4 === 0) await h.page.keyboard.down("Meta");
    await sample();
  }
  await idle(h);
  const wiggled = await peekStats(h);
  // on to another name (above: the peek covers the lines below): it replaces the first one
  const c = await wordAt(h, "schedule", "remaining = self.max_num_batched_tokens", "max_num_batched_tokens");
  await h.page.mouse.move(c.x, c.y, { steps: 6 });
  await h.page.keyboard.down("Meta");
  await until(
    h,
    "the peek moves on to max_num_batched_tokens",
    async () => !!(await title()) && (await title()) !== first && (await h.page.locator(".pop.k-peek").count()) === 1,
  );
  await idle(h);
  await shot(h, "peek-cmdheld-one");
  // sweep a whole line of names
  const l0 = await wordAt(h, "schedule", "while self.waiting and len(scheduled_seqs)", "while");
  const l1 = await wordAt(h, "schedule", "self.max_num_seqs:", "max_num_seqs");
  await h.page.mouse.move(l0.x, l0.y, { steps: 4 });
  for (let i = 1; i <= 20; i++) {
    await h.page.mouse.move(l0.x + ((l1.x - l0.x) * i) / 20, l0.y);
    if (i % 5 === 0) await h.page.keyboard.down("Meta");
    await sample();
  }
  await h.page.locator(".pop.k-peek .pt").waitFor();
  await idle(h); // the name the sweep stopped on
  const swept = await peekStats(h);
  check(
    "cmdHeldBeforeHoverShowsOnePeek with ⌘ held from before the hover, at most one peek is shown at a time and none is pinned",
    swept.max <= 1 && swept.pinnedMax === 0 && Math.max(...samples) <= 1 && swept.now === 1,
    { wiggled, swept, samples, first },
  );
  await h.page.keyboard.up("Meta");

  // the explicit pin is unchanged: pressing ⌘ while a peek shows pins it
  await h.page.keyboard.down("Meta");
  await h.page.locator(".pop.k-peek .pinned").waitFor();
  await h.page.keyboard.up("Meta");
  const pinned = await peekStats(h);
  check(
    "cmdHeldBeforeHoverShowsOnePeek pressing ⌘ while a peek shows still pins it",
    pinned.now === 1 && pinned.pinnedNow === 1,
    pinned,
  );
  await h.page.context().close();
});

test("cudaKeywordNotPeekable", async () => {
  const b = emptyBoard("b1", "board");
  put(b, free("cu", "cuda-cpp", CUDA, "rgb_to_grayscale.cu"), 60, 40, 900);
  put(b, free("rs", "rust", RUST, "frob.rs"), 60, 300, 600);
  b.cam = { x: 0, y: 0, z: 1 };
  const h = await open({ board: b, light, w: 1300, h: 900 });
  await idle(h);
  const peeks = () => h.sent.filter((m) => m.type === "peek").map((m) => (m as { word: string }).word);
  const words: [string, string, string][] = [
    ["rgb_to_grayscale.cu", "__global__ void", "__global__"],
    ["rgb_to_grayscale.cu", "__shared__ float", "__shared__"],
    ["rgb_to_grayscale.cu", "static_cast<unsigned", "static_cast"],
    ["frob.rs", "pub fn frobnicate", "pub"],
    ["frob.rs", "let y", "let"],
  ];
  const shown: Record<string, number> = {};
  for (const [card, line, word] of words) {
    await h.page.mouse.move(5, 5);
    await expect(h.page.locator(".pop.k-peek")).toHaveCount(0);
    const p = await wordAt(h, card, line, word);
    await h.page.mouse.move(p.x - 2, p.y);
    await h.page.mouse.move(p.x, p.y, { steps: 2 });
    await hold(h, PEEK_DELAY + 300, `a keyword hovered past the peek delay: no peek opens and nothing is asked`);
    shown[word] = await h.page.locator(".pop.k-peek").count();
  }
  const asked = peeks();
  // a name on the same line still peeks (the free card has no definition: "No definition found")
  const n = await wordAt(h, "rgb_to_grayscale.cu", "void rgb_to_grayscale", "rgb_to_grayscale");
  await h.page.mouse.move(n.x - 2, n.y);
  await h.page.mouse.move(n.x, n.y, { steps: 2 });
  await h.page.locator(".pop.k-peek .pt").waitFor();
  await idle(h);
  await shot(h, "peek-cuda-name");
  check(
    "cudaKeywordNotPeekable CUDA / C++ qualifiers and keywords and Rust keywords open no peek and ask nothing",
    Object.values(shown).every((x) => x === 0) && asked.length === 0,
    { shown, asked },
  );
  check("cudaKeywordNotPeekable a name on the same line still peeks", peeks().includes("rgb_to_grayscale"), peeks());
  await h.page.context().close();
});

test("peekNoDefNamesLanguageExtension", async () => {
  const b: Board = emptyBoard("b1", "board");
  put(b, free("cu", "cuda-cpp", CUDA, "rgb_to_grayscale.cu"), 60, 40, 900);
  put(b, free("rs", "rust", RUST, "frob.rs"), 60, 260, 600);
  put(b, free("py", "python", PY, "handler.py"), 60, 460, 600);
  b.cam = { x: 0, y: 0, z: 1 };
  const h = await open({ board: b, light, w: 1300, h: 900 });
  await idle(h);
  const said: Record<string, string> = {};
  for (const [card, line, word] of [
    ["rgb_to_grayscale.cu", "void rgb_to_grayscale", "rgb_to_grayscale"],
    ["frob.rs", "fn frobnicate", "frobnicate"],
    ["handler.py", "obj.unknown_attr_xyz", "unknown_attr_xyz"],
  ] as const) {
    await h.page.mouse.move(5, 5);
    await expect(h.page.locator(".pop.k-peek")).toHaveCount(0);
    const p = await wordAt(h, card, line, word);
    await h.page.mouse.move(p.x - 2, p.y);
    await h.page.mouse.move(p.x, p.y, { steps: 2 });
    await h.page.locator(".pop.k-peek .empty").waitFor();
    await idle(h);
    said[card] = (await h.page.locator(".pop.k-peek .empty").textContent()) ?? "";
    if (card === "rgb_to_grayscale.cu") await shot(h, "peek-nodef-cuda");
  }
  const cu = said["rgb_to_grayscale.cu"],
    rs = said["frob.rs"],
    py = said["handler.py"];
  check(
    "peekNoDefNamesLanguageExtension C/C++/CUDA names clangd or ms-vscode.cpptools, not Python",
    /clangd/.test(cu) && /cpptools/.test(cu) && !/Python|setattr/.test(cu),
    cu,
  );
  check(
    "peekNoDefNamesLanguageExtension Rust names rust-analyzer",
    /rust-analyzer/.test(rs) && !/Python|setattr/.test(rs),
    rs,
  );
  check(
    "peekNoDefNamesLanguageExtension Python keeps setattr and the Python extension",
    /setattr/.test(py) && /Python extension/.test(py),
    py,
  );
  await h.page.context().close();
});
