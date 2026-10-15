// 白板交互场景：每个场景开一个白板、做一串操作、截图。
import { ready, open, shot, symCard, findSym, type Host } from "./harness";
import { emptyBoard, type Board } from "@codeboard/core";

const light = process.argv.includes("--light");
const names = process.argv.slice(2).filter((a) => !a.startsWith("--"));

function boardWith(...quals: string[]): Board {
  const b = emptyBoard("b1", "nano-vllm · generate 主流程");
  let x = 80;
  for (const q of quals) { const s = findSym(q); const c = symCard(s.f, s.s); c.x = x; c.y = 80; x += 640; b.cards.push(c); }
  return b;
}
const callEl = (h: Host, name: string, nth = 0) => h.page.locator(`.card .src .call:text-is("${name}")`).nth(nth);

const S: Record<string, () => Promise<void>> = {
  async basic() {
    const h = await open({ board: boardWith("LLMEngine.step"), light });
    await shot(h, "01-start");
    await callEl(h, "schedule").click();
    await h.page.waitForTimeout(900);
    await shot(h, "02-expanded");
    await callEl(h, "postprocess").click();
    await h.page.waitForTimeout(900);
    await shot(h, "03-two");
    console.log("cards:", h.board().cards.length, "links:", h.board().links.length);
    await h.page.context().browser()!.close();
  },
  async flow() {
    const h = await open({ board: boardWith("LLMEngine.step"), light });
    await callEl(h, "schedule").click(); await h.page.waitForTimeout(700);
    await shot(h, "flow-00");
    await callEl(h, "postprocess").first().click({ timeout: 5000 }); await h.page.waitForTimeout(700);
    const pos = () => JSON.stringify(h.board().cards.map((c: any) => [c.segments?.[0]?.symbol?.qual, c.x, c.y]));
    await h.page.waitForTimeout(1200); console.log(pos());
    await h.page.locator(".card .src .call", { hasText: "allocate" }).first().click();
    await h.page.waitForTimeout(1200); console.log(pos(), JSON.stringify(h.board().links.map((l) => [l.from.card, l.to.card]))); await h.page.waitForTimeout(700);
    await h.page.keyboard.press("Shift+!"); await h.page.waitForTimeout(700);
    await shot(h, "flow-01-three");
    await h.page.keyboard.press("Escape");
    await h.page.keyboard.press("p"); await h.page.waitForTimeout(900);
    await shot(h, "flow-02-walk");
    await h.page.keyboard.press("ArrowRight"); await h.page.waitForTimeout(900);
    await shot(h, "flow-03-walk2");
    await h.page.keyboard.press("Escape");
    console.log("cards:", h.board().cards.length, "links:", h.board().links.length);
    await h.page.context().browser()!.close();
  },
  async notes() {
    const h = await open({ board: boardWith("Scheduler.schedule"), light });
    await h.page.locator(".card .no").nth(5).click();
    await h.page.locator(".card .no").nth(7).click({ modifiers: ["Shift"] });
    await shot(h, "notes-01-lines");
    await h.page.keyboard.press("s"); await h.page.waitForTimeout(400);
    await shot(h, "notes-02-add");
    await h.page.locator(".pop button", { hasText: /^Text$/ }).click();
    await h.page.locator(".pop textarea, .pop [contenteditable]").first().click();
    await h.page.keyboard.type("Prefill admits waiting seqs until the token budget runs out.");
    await h.page.locator(".pop button", { hasText: /^Add$/ }).click();
    await h.page.waitForTimeout(400);
    await shot(h, "notes-03-done");
    await h.page.mouse.move(1300, 800);
    await h.page.keyboard.press("n"); await h.page.waitForTimeout(300);
    await h.page.keyboard.type("# Why chunked prefill\nKeeps $O(n)$ memory **bounded**.");
    await h.page.keyboard.press("Escape"); await h.page.waitForTimeout(300);
    await h.page.mouse.click(1300, 500);
    await shot(h, "notes-04-note");
    console.log("cards:", h.board().cards.map((c) => c.kind).join(","), "sidenotes:", JSON.stringify((h.board() as any).sidenotes));
    await h.page.locator(".card .mk").first().hover(); await h.page.waitForTimeout(600);
    await shot(h, "notes-05-hover");
    await h.page.context().browser()!.close();
  },
  async sections() {
    const b = boardWith("LLMEngine.step", "Scheduler.schedule");
    const h = await open({ board: b, light });
    await h.page.keyboard.press("Shift+!"); await h.page.waitForTimeout(600);
    const r = await h.page.locator(".card").first().boundingBox();
    await h.page.locator(".bbar button", { hasText: "Section" }).click();
    await h.page.mouse.move(r!.x - 40, r!.y - 60); await h.page.mouse.down();
    await h.page.mouse.move(r!.x + r!.width + 30, r!.y + r!.height + 40, { steps: 8 }); await h.page.mouse.up();
    await h.page.waitForTimeout(400);
    await h.page.keyboard.type("Engine"); await h.page.keyboard.press("Enter");
    await h.page.locator(".bbar button", { hasText: "Section" }).click();
    await h.page.mouse.move(r!.x - 80, r!.y - 120); await h.page.mouse.down();
    await h.page.mouse.move(1350, 820, { steps: 8 }); await h.page.mouse.up();
    await h.page.waitForTimeout(300);
    await h.page.keyboard.type("Generate step"); await h.page.keyboard.press("Enter");
    await h.page.waitForTimeout(400);
    await shot(h, "sec-01-nested");
    console.log(JSON.stringify(h.board().sections.map((s) => [s.name, s.parent ?? null])), JSON.stringify(h.board().cards.map((c) => c.section ?? null)));
    await h.page.context().browser()!.close();
  },
  async compare() {
    const h = await open({ board: boardWith("Scheduler.schedule", "Scheduler.postprocess"), light });
    await h.page.keyboard.press("Shift+!"); await h.page.waitForTimeout(500);
    await h.page.keyboard.press("Control+a"); await h.page.keyboard.press("Meta+a");
    await h.page.locator(".card").first().locator(".chead").click({ button: "right" });
    await h.page.waitForTimeout(200);
    await shot(h, "cmp-01-menu");
    await h.page.locator(".ctx button", { hasText: "Compare" }).first().click();
    await h.page.waitForTimeout(900);
    await shot(h, "cmp-02-compare");
    console.log("kinds:", h.board().cards.map((c) => c.kind).join(","));
    await h.page.context().browser()!.close();
  },
  async versions() {
    const b = boardWith("Scheduler.schedule");
    const h = await open({ board: b, light });
    const seg = (b.cards[0] as any).segments[0].id;
    await h.post({ type: "stale", stale: { [seg]: { state: "changed", hiddenOnly: false, head: "f64d8210" } } } as any);
    await h.page.waitForTimeout(400);
    await shot(h, "ver-01-stale");
    await h.page.locator(".banner button", { hasText: "Review" }).click();
    await h.page.waitForTimeout(1200);
    await shot(h, "ver-02-diff");
    console.log(await h.page.evaluate(() => [...document.querySelectorAll(".pop, .pop .diffpop, .pop .dbody, .pop .crows, .pop .db")].map((e) => { const r = e.getBoundingClientRect(); return e.className + " " + Math.round(r.x) + " " + Math.round(r.width) + " " + getComputedStyle(e).width; }).join("\n")));
    await h.page.locator(".pop button", { hasText: /^Update/ }).first().click();
    await h.page.waitForTimeout(600);
    await shot(h, "ver-03-updated");
    console.log("version:", JSON.stringify((h.board().cards[0] as any).segments[0].version));
    await h.page.context().browser()!.close();
  },
  async palette() {
    const h = await open({ board: boardWith("LLMEngine.step"), light });
    await h.page.keyboard.press("Control+k"); await h.page.keyboard.press("Meta+k");
    await h.page.waitForTimeout(300);
    await shot(h, "pal-01-entry");
    await h.page.keyboard.type("alloc"); await h.page.waitForTimeout(400);
    await shot(h, "pal-02-query");
    await h.page.keyboard.press("Enter"); await h.page.waitForTimeout(900);
    await shot(h, "pal-03-placed");
    console.log("cards:", h.board().cards.length);
    await h.page.context().browser()!.close();
  },
  async peek() {
    const h = await open({ board: boardWith("Scheduler.schedule"), light });
    await h.page.locator(".card .src .call", { hasText: "can_allocate" }).first().hover();
    await h.page.waitForTimeout(1200);
    await shot(h, "peek-01");
    await h.page.context().browser()!.close();
  },
};

(async () => {
  await ready();
  for (const n of names.length ? names : Object.keys(S)) { console.log("▶", n); await S[n](); }
})().catch((e) => { console.error(e); process.exit(1); });
