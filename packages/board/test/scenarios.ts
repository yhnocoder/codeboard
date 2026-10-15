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
};

(async () => {
  await ready();
  for (const n of names.length ? names : Object.keys(S)) { console.log("▶", n); await S[n](); }
})().catch((e) => { console.error(e); process.exit(1); });
