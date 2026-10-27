// Broken chains + cross-language. One browser plays the board; the host is the real resolver
// (packages/host/src/resolve.ts) on the crosslang fixture repo through the node workspace, with a stub language
// server for dynamic dispatch (definition = the base method, implementations = the overrides, as Pylance answers).
import * as fs from "node:fs";
import * as path from "node:path";
import { emptyBoard, DEFAULT_SETTINGS, type Board, type CodeCard, type SegView, type HostToBoard } from "@codeboard/core";
import { shot, put, OUT, REPO, type Host } from "../harness";
import { startAnalysis, analysisOf } from "@codeboard/host/analysis";
import { cardForFileSym } from "@codeboard/host/cards";
import { callVars, dispatchAt, expand, peek } from "@codeboard/host/resolve";
import { viewsFor } from "@codeboard/host/views";
import { forgetDefs } from "@codeboard/host/defcache";
import { searchName, searchPick, genSource } from "@codeboard/host/search";
import { resetIndex, startNameIndex, nameIndexReady } from "@codeboard/host/nameindex";
import { langOf, useWorkspace } from "@codeboard/host/ws";
import { nodeWorkspace, type TestWorkspace } from "@codeboard/host/test/node-workspace";
import { test, open, check, light, verdict, expect, until, idle } from "../fixtures";


/** Screenshot also into the PR shots folder when SHOTS_DIR is set */
async function shotPr(h: Host, name: string) {
  await shot(h, name);
  const d = process.env.SHOTS_DIR;
  if (d) { fs.mkdirSync(d, { recursive: true }); fs.copyFileSync(path.join(OUT, `${name}.png`), path.join(d, `${name}.png`)); }
}

let FIX = "", W: TestWorkspace;
async function fixture() {
  if (FIX) return;
  FIX = fs.mkdtempSync("/tmp/codeboard-chains-");
  fs.cpSync(path.join(REPO, "packages/host/test/fixtures/crosslang"), FIX, { recursive: true });
  W = nodeWorkspace(FIX);
  useWorkspace(W);
  await startAnalysis(path.join(REPO, "node_modules/@vscode/tree-sitter-wasm/wasm"));
  resetIndex(); startNameIndex(); await nameIndexReady();
}
async function symCard(rel: string, qual: string, last = false): Promise<CodeCard> {
  const abs = path.join(FIX, rel);
  const syms = analysisOf(langOf(abs), fs.readFileSync(abs, "utf8")).symbols.filter((s) => s.qual === qual);
  const sym = last ? syms[syms.length - 1] : syms[0];
  return (await cardForFileSym(abs, sym))!.card as CodeCard;
}

/** The board with the real host behind it (only the messages these scenarios use; the rest fall back to the harness mock) */
async function chainsHost(b: Board): Promise<Host> {
  const segs = b.cards.flatMap((c) => (c.kind === "code" ? c.segments : []));
  const views: Record<string, SegView> = await viewsFor(segs);
  let h!: Host;
  h = await open({
    board: b, light, w: 1700, h: 1000,
    on: async (m, reply) => {
      switch (m.type) {
        case "ready": return true; // init below, once open() has returned the page
        case "expand": await reply(m.req, await expand(m)); return true;
        case "dispatch": await reply(m.req, await dispatchAt(m)); return true;
        case "peek": await reply(m.req, await peek(m)); return true;
        case "views": await reply(m.req, await viewsFor(m.segs)); return true;
        case "callVars": await reply(m.req, await callVars(m)); return true;
        case "searchName": await reply(m.req, await searchName(m.name)); return true;
        case "searchPick": await reply(m.req, await searchPick(m.item)); return true;
        case "genSource": await reply(m.req, await genSource(m.from)); return true;
        case "prefetch": return true;
        default: return false;
      }
    },
  });
  const init: HostToBoard = { type: "init", board: b, boards: [{ id: b.id, name: b.name, cards: b.cards.length }], views, stale: {}, host: { isMac: true, assetBase: "", target: true, settings: { ...DEFAULT_SETTINGS } } };
  await h.post(init);
  await h.page.locator(".card").first().waitFor(); await idle(h);
  return h;
}

/** Fit all (or the selection), then zoom out a little: the grey boxes and labels beside the cards are not in the fit.
 *  Stops before the cards drop to the overview level of detail (code drawn as bars) */
async function fitWide(h: Host, sel = false, steps = 4) {
  await h.page.keyboard.press(sel ? "Shift+Digit2" : "Shift+Digit1"); await idle(h);
  for (let i = 0; i < steps; i++) {
    await h.page.evaluate(() => document.querySelector("#board")!.dispatchEvent(new WheelEvent("wheel", { deltaY: 6, ctrlKey: true, clientX: 700, clientY: 460, bubbles: true, cancelable: true })));
    await idle(h);
    if (await h.page.locator(".card.lo-ov").count()) {
      await h.page.evaluate(() => document.querySelector("#board")!.dispatchEvent(new WheelEvent("wheel", { deltaY: -6, ctrlKey: true, clientX: 700, clientY: 460, bubbles: true, cancelable: true })));
      break;
    }
  }
  await h.page.mouse.move(5, 5);
  await idle(h);
}
const callIn = (h: Host, card: string, name: string) => h.page.locator(`.card[data-id="${card}"] .call`, { hasText: new RegExp(`^${name}$`) }).first();
const linksOf = (h: Host) => h.board().links;
const cardByQual = (h: Host, qual: string) => h.board().cards.find((c) => c.kind === "code" && c.segments[0]?.symbol?.qual === qual);

test("pickimpl", () => verdict("pickimpl", pickimpl));

test("crosslang", () => verdict("crosslang", crosslang));

async function pickimpl(res: Record<string, unknown>) {
  await fixture();
  // stub language server: self.impl.forward → AttentionImpl.forward; its implementations → the two subclasses
  const baseAbs = path.join(FIX, "vllm/base.py"), implAbs = path.join(FIX, "vllm/impls.py");
  W.language.definitions = async (abs, line) => (abs.endsWith("vllm/layer.py") && line === 7 ? [{ abs: baseAbs, line: 2, col: 8 }] : []);
  W.language.implementations = async (abs, line) => (abs === baseAbs && line === 2 ? [{ abs: implAbs, line: 5, col: 8 }, { abs: implAbs, line: 10, col: 8 }] : []);
  forgetDefs();
  const B = emptyBoard("bPick", "vLLM · attention");
  const lay = await symCard("vllm/layer.py", "Attention.forward");
  put(B, lay, 80, 160, 620);
  const h = await chainsHost(B), page = h.page;

  // 0. Hover: the definition preview says Dynamic dispatch · 2 implementations
  const call = callIn(h, lay.id, "forward");
  const cb = (await call.boundingBox())!;
  await page.mouse.move(cb.x + 4, cb.y + cb.height / 2); await page.mouse.move(cb.x + 8, cb.y + cb.height / 2, { steps: 2 });
  await page.locator(".pop .pk-disp").waitFor(); // after the hover delay and the host's peek reply
  res.hover = await page.locator(".pop .pk-disp").textContent();
  await page.mouse.move(10, 880);
  await expect(page.locator(".pop .pk-disp")).toHaveCount(0); await idle(h);

  // 1. Click the call: the implementation picker (title, list, Why this one?)
  await call.click();
  await page.locator(".pop.k-impls .cand").first().waitFor(); await idle(h);
  res.title = await page.locator(".pop.k-impls .pt").textContent();
  res.items = await page.locator(".pop.k-impls .cand").count();
  await page.locator(".pop.k-impls input.fld").fill("decode path runs Triton on ROCm");
  await page.locator(".pop.k-impls .cand").nth(1).hover();
  await shotPr(h, "pickimpl-1-picker");

  // 2. Pick TritonAttentionImpl: card + Call arrow labelled with the reason, Flash stays as a grey box
  await page.locator(".pop.k-impls .cand").nth(1).click();
  await until(h, "the picked implementation's card and arrow are saved", () => cardByQual(h, "TritonAttentionImpl.forward") && linksOf(h).find((l) => l.call?.impls)); await idle(h);
  const L = linksOf(h).find((l) => l.call?.impls);
  const tri = cardByQual(h, "TritonAttentionImpl.forward");
  res.picked = !!tri && L?.to.card === tri.id && L?.label === "decode path runs Triton on ROCm" && L?.call?.alts?.[0]?.qual === "FlashAttentionImpl.forward";
  res.altBoxes = await page.locator(".altbox").count();
  res.oneOf = await page.locator(`.card[data-id="${tri?.id}"] .disp1`).textContent();
  await fitWide(h, false, 0);
  await shotPr(h, "pickimpl-2-alternatives");

  // 3. Click the grey box: Flash swaps in, Triton turns grey
  await page.locator(".altbox").first().click();
  await until(h, "the grey box's implementation swaps in", () => cardByQual(h, "FlashAttentionImpl.forward")); await idle(h);
  const L2 = linksOf(h).find((l) => l.id === L?.id);
  const fl = cardByQual(h, "FlashAttentionImpl.forward");
  res.swapped = !!fl && L2?.to.card === fl.id && !cardByQual(h, "TritonAttentionImpl.forward") && L2?.call?.alts?.[0]?.qual === "TritonAttentionImpl.forward" && L2?.label === "decode path runs Triton on ROCm";
  res.altAfter = await page.locator(".altbox .lb").first().textContent();

  // 4. Click the call again: jumps to the chosen card (no new card)
  const n0 = h.board().cards.length;
  await page.keyboard.press("Escape");
  await callIn(h, lay.id, "forward").click(); await idle(h);
  res.jump = h.board().cards.length === n0 && !(await page.locator(".pop.k-impls").count());

  // 5. Expand Again re-picks: Triton as a second branch from the same call site
  await callIn(h, lay.id, "forward").click({ button: "right" });
  await page.locator(".ctx button", { hasText: "Expand Again" }).click();
  await page.locator(".pop.k-impls .cand").nth(1).click(); // the picker comes with the host's reply
  await until(h, "the second branch is saved", () => linksOf(h).filter((l) => l.call?.name === "forward").length === 2); await idle(h);
  res.two = linksOf(h).filter((l) => l.call?.name === "forward").length === 2;
  res.altsWhenBoth = await page.locator(".altbox").count();

  // 6. Unresolvable: Search “unified_attention” in All Languages → the string registration → dashed manual arrow
  await page.keyboard.press("Escape");
  await callIn(h, lay.id, "unified_attention").click({ button: "right" });
  await page.locator(".ctx button").first().waitFor(); await idle(h);
  res.menu = await page.locator(".ctx button", { hasText: /Search “unified_attention” in All Languages/ }).count() === 1 && await page.locator(".ctx button", { hasText: "Draw Call Arrow Manually…" }).count() === 1;
  await page.locator(".ctx button", { hasText: /Search “unified_attention”/ }).click();
  await page.locator(".pop.k-names .cand").first().waitFor(); await idle(h);
  res.groups = await page.locator(".pop.k-names .grp-h").allTextContents();
  res.hits = await page.locator(".pop.k-names .cand").count();
  await page.locator(".pop.k-names .cand", { hasText: "direct_register_custom_op" }).click();
  await until(h, "the manual arrow is saved", () => linksOf(h).find((l) => l.call?.ev?.kind === "manual")); await idle(h);
  const ml = linksOf(h).find((l) => l.call?.ev?.kind === "manual");
  res.manual = !!ml && ml.call?.ev?.via === "registry" && await page.locator(".edge.ev-manual").count() >= 1 && /via registry · manual/.test(await page.locator(".ev-tag.manual").first().textContent() ?? "");

  // 7. Draw Call Arrow Manually…: connect mode, click a card → manual Call arrow
  await callIn(h, lay.id, "forward").click({ button: "right" });
  await page.locator(".ctx button", { hasText: "Draw Call Arrow Manually…" }).click(); await idle(h);
  const fl2 = cardByQual(h, "FlashAttentionImpl.forward");
  await page.locator(`.card[data-id="${fl2?.id}"] .chead`).click({ position: { x: 160, y: 10 } });
  await until(h, "the drawn arrow is saved", () => linksOf(h).filter((l) => l.call?.ev?.kind === "manual").length === 2); await idle(h);
  res.drawn = linksOf(h).filter((l) => l.call?.ev?.kind === "manual").length === 2;
  await page.keyboard.press("Shift+Digit1"); await idle(h);
  await shotPr(h, "pickimpl-3-manual");

  // 8. Go to Implementation is slow (a cold Pylance searching the whole workspace): the click doesn't wait for it.
  // The definition's card comes first; when the implementations arrive the picker opens, and picking one swaps it in (the abstract base is not kept)
  await page.keyboard.press("Escape");
  W.language.implementations = async (abs, line) => { await new Promise((r) => setTimeout(r, 1500)); return abs === baseAbs && line === 2 ? [{ abs: implAbs, line: 5, col: 8 }, { abs: implAbs, line: 10, col: 8 }] : []; };
  forgetDefs();
  await h.page.context().close();
  const B8 = emptyBoard("bPickLate", "vLLM · attention (cold language server)");
  const lay8 = await symCard("vllm/layer.py", "Attention.forward");
  put(B8, lay8, 80, 160, 620);
  const h8 = await chainsHost(B8);
  const n8 = h8.board().cards.length;
  await callIn(h8, lay8.id, "forward").click();
  // not idle(): that would wait for the implementations' reply (1.5 s), and the picker would be open by then
  await h8.page.locator(".card .ctitle", { hasText: /^AttentionImpl\.forward$/ }).waitFor();
  res.lateCard = await h8.page.locator(".card .ctitle", { hasText: /^AttentionImpl\.forward$/ }).count(); // on the board before the implementations come back
  await until(h8, "the definition's card is saved first", () => cardByQual(h8, "AttentionImpl.forward"), 1000);
  res.lateFirst = res.lateCard === 1 && !!cardByQual(h8, "AttentionImpl.forward") && h8.board().cards.length === n8 + 1 && !(await h8.page.locator(".pop.k-impls").count());
  await h8.page.locator(".pop.k-impls .cand").first().waitFor({ timeout: 5000 }); await idle(h8);
  res.lateItems = await h8.page.locator(".pop.k-impls .cand").count();
  await h8.page.locator(".pop.k-impls input.fld").fill("late pick");
  await h8.page.locator(".pop.k-impls .cand", { hasText: "TritonAttentionImpl" }).click();
  await until(h8, "the late pick swaps its card in", () => linksOf(h8).find((l) => l.label === "late pick") && !cardByQual(h8, "AttentionImpl.forward")); await idle(h8);
  const L8 = linksOf(h8).find((l) => l.label === "late pick");
  const t8 = L8 && h8.board().cards.find((c) => c.id === L8.to.card);
  res.lateSwap = !!t8 && t8.kind === "code" && t8.segments[0]?.symbol?.qual === "TritonAttentionImpl.forward" && !cardByQual(h8, "AttentionImpl.forward")
    && L8?.call?.impls === 2 && (L8?.call?.alts ?? []).map((a) => a.qual).join(",") === "FlashAttentionImpl.forward";

  const ok = /Dynamic dispatch.*2 implementations.*AttentionImpl.*abstract/.test(String(res.hover)) && /2 implementations of/.test(String(res.title)) && res.items === 2
    && res.picked && res.altBoxes === 1 && res.oneOf === "1 of 2" && res.swapped && /TritonAttentionImpl/.test(String(res.altAfter)) && res.jump && res.two && res.altsWhenBoth === 0
    && res.menu && (res.hits as number) >= 2 && res.manual && res.drawn && res.lateFirst && res.lateItems === 2 && res.lateSwap;
  check("pickimpl", ok, JSON.stringify(res));
  W.language.definitions = async () => []; W.language.implementations = async () => [];
  forgetDefs();
  await h8.page.context().close();
}

async function crosslang(res: Record<string, unknown>) {
  await fixture();
  const B = emptyBoard("bCross", "DeepEP · intranode dispatch");
  const buf = await symCard("deep_ep/buffer.py", "Buffer.dispatch");
  put(B, buf, 60, 120, 520);
  const h = await chainsHost(B), page = h.page;

  // 1. Python → pybind → C++ → launch macro → CUDA kernel (each path already names its language, so no card adds one)
  await callIn(h, buf.id, "intranode_dispatch").click();
  await until(h, "the pybind call expands into the C++ card", () => cardByQual(h, "deep_ep::Buffer::intranode_dispatch"), 6000); await idle(h);
  const cpp = cardByQual(h, "deep_ep::Buffer::intranode_dispatch");
  res.pybind = !!cpp && linksOf(h).some((l) => l.to.card === cpp.id && l.call?.bound === "pybind · deep_ep.cpp .def");
  await callIn(h, cpp!.id, "dispatch").click();
  await until(h, "the C++ call expands into the launching host function", () => h.board().cards.some((c) => c.kind === "code" && c.segments[0].text.some((t) => /SWITCH_RANKS\(DISPATCH/.test(t))), 6000);
  await idle(h);
  const hostFn = h.board().cards.find((c) => c.kind === "code" && c.segments[0].text.some((t) => /SWITCH_RANKS\(DISPATCH/.test(t)));
  res.host = !!hostFn;
  await callIn(h, hostFn!.id, "SWITCH_RANKS").click();
  await until(h, "the launch macro expands into the kernel", () => linksOf(h).some((l) => l.call?.bound === "launch macro · SWITCH_RANKS"), 6000); await idle(h);
  const kl = linksOf(h).find((l) => l.call?.bound === "launch macro · SWITCH_RANKS");
  const kern = h.board().cards.find((c) => c.id === kl?.to.card) as CodeCard | undefined;
  res.kernel = kern?.title;
  res.vals = kl?.call?.vals?.map((v) => `${v.name}=${v.value}`).join(" ");
  res.paths = await page.locator(".chead .cpath").allTextContents();
  res.labels = await page.locator(".vbt").allTextContents();
  // drag the kernel card a little right and down so the boundary label sits between the cards
  await page.keyboard.press("Shift+Digit1"); await idle(h);
  const kh = (await page.locator(`.card[data-id="${kern?.id}"] .chead`).boundingBox())!;
  await page.mouse.move(kh.x + kh.width - 120, kh.y + 8); await page.mouse.down();
  await page.mouse.move(kh.x + kh.width + 180, kh.y + 40, { steps: 10 }); await page.mouse.up(); await idle(h);
  await fitWide(h);
  await shotPr(h, "crosslang-1-deepep-chain");

  // 2. The value picker: kNumRanks 8 → 4 (others stay grey branches beside the kernel card)
  res.greyVals = await page.locator(".altbox").count();
  await page.locator(".vval.opt").first().click();
  await page.locator(".pop.k-vals .cand").first().waitFor(); await idle(h);
  res.valOpts = await page.locator(".pop.k-vals .cand").count();
  await shotPr(h, "crosslang-2-value-picker");
  await page.locator(".pop.k-vals .cand", { hasText: "kNumRanks → 4" }).click();
  await until(h, "the picked value is saved", () => linksOf(h).find((l) => l.id === kl?.id)?.call?.vals?.[0]?.value === "4"); await idle(h);
  res.valSet = linksOf(h).find((l) => l.id === kl?.id)?.call?.vals?.[0]?.value === "4" && (h.board().cards.find((c) => c.id === kern?.id) as CodeCard | undefined)?.title === "dispatch<4, 768, 8192>";

  // 3. Generated card from the clipboard: dashed card, Generated · CUDA source, run note, dotted Generated from arrow
  W.ui.clipboard = async () => "// generated by DeepEP JIT for num_ranks=8\n#include <cuda_runtime.h>\n__global__ void dispatch_8_768(int4* recv_x, const int4* x, int num_tokens) {\n    const int sm_id = blockIdx.x;\n    if (sm_id >= 8) return;\n    recv_x[threadIdx.x] = x[threadIdx.x];\n}\n";
  await page.locator(`.card[data-id="${kern?.id}"] .gutter .no`).nth(2).evaluate((el) => (el as HTMLElement).click());
  await page.locator(`.card[data-id="${kern?.id}"] .gutter .no.sel`).first().waitFor();
  const kLine = page.locator(`.card[data-id="${kern?.id}"] .src .l`).nth(2);
  const kb = (await kLine.boundingBox())!;
  await page.mouse.click(kb.x + kb.width - 30, kb.y + kb.height / 2, { button: "right" });
  await page.locator(".ctx button").first().waitFor();
  // the line menu when the right-click lands on the selected line, else the card menu's Edit ▸
  if (!(await page.locator(".ctx button", { hasText: "Add Generated Code" }).count())) { await page.locator(".ctx button", { hasText: /^Edit/ }).hover(); }
  await page.locator(".ctx button", { hasText: "Add Generated Code" }).hover();
  await page.locator(".ctx button", { hasText: "Paste from Clipboard" }).click();
  await until(h, "the generated card is saved", () => h.board().cards.some((c) => c.kind === "code" && c.gen)); await idle(h);
  const gen = h.board().cards.find((c) => c.kind === "code" && c.gen) as CodeCard | undefined;
  res.gen = gen?.gen;
  res.genLink = linksOf(h).some((l) => l.gen && l.from.card === gen?.id && l.to.card === kern?.id);
  res.genHead = await page.locator(`.card[data-id="${gen?.id}"] .gentag`).textContent();
  await page.keyboard.press("Escape");
  // an empty spot in each header (cards can be small on screen at this zoom)
  const headSpot = async (id?: string) => ({ x: (await page.locator(`.card[data-id="${id}"] .chead`).boundingBox())!.width * 0.75, y: 6 });
  await page.locator(`.card[data-id="${kern?.id}"] .chead`).click({ position: await headSpot(kern?.id) });
  await page.locator(`.card[data-id="${gen?.id}"] .chead`).click({ position: await headSpot(gen?.id), modifiers: ["Shift"] });
  await fitWide(h, true);
  await page.keyboard.press("Escape");
  await shotPr(h, "crosslang-3-generated");

  // 4. Triton kernel[grid] and the sglang-style autotune configs as grey alternatives (no screenshot)
  const inv = await symCard("ops/kern.py", "invoke_fused_moe_kernel");
  const r = await expand({ seg: inv.segments[0], line: inv.segments[0].start + inv.segments[0].text.findIndex((t) => /fused_moe_kernel\[grid\]/.test(t)), col: inv.segments[0].text.find((t) => /fused_moe_kernel\[grid\]/.test(t))!.indexOf("fused_moe_kernel"), name: "fused_moe_kernel" });
  res.triton = "card" in r && r.mark?.bound === "kernel[grid]" && (r.mark?.alts?.length ?? 0) === 2;

  const g = res.gen as { what?: string; run?: string } | undefined;
  const ok = (res.paths as string[]).length >= 4 && !(res.paths as string[]).some((t) => t.includes(" · ")) && res.pybind && res.host && res.kernel === "dispatch<8, 768, 8192>" && res.vals === "kNumRanks=8 kNumThreads=768 kNumTMABytesPerWarp=8192"
    && (res.labels as string[]).includes("launch macro · SWITCH_RANKS") && (res.labels as string[]).includes("pybind · deep_ep.cpp .def")
    && res.greyVals === 2 && res.valOpts === 3 && res.valSet && g?.what === "CUDA source" && !!g?.run && res.genLink && /Generated · CUDA source/.test(String(res.genHead)) && res.triton;
  check("crosslang", ok, JSON.stringify(res));
  await h.page.context().close();
}
