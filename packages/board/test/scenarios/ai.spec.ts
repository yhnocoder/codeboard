// Settings › AI and Auto Focus. Auto Focus runs the host's own request code (packages/host/src/imageai.ts) answered by a fake DeepSeek.
//   aiSettingsSection               the AI section: the DeepSeek key shows only Set / Not set (Set Key… and Clear ask the host, the
//                                   key never reaches the board), the DeepSeek model, the inline-completion model, a model for each
//                                   tool (Auto, DeepSeek or a VS Code model; the image tools can't pick a model without image input)
//                                   and the Convert to SVG defaults, all saved as settings
//   autoFocusNote                   right-click a Note: Auto Focus sends its Markdown (the rules, no thinking), the card is busy while
//                                   waiting, the reply with ==highlights== and **bold** is written back in one change, ⌘Z undoes it
//   autoFocusRejectsAlteredReply    a reply that changes a word (or marks inside code) is not applied: the Note stays as it was,
//                                   the notice says why, and there is nothing to undo
import * as path from "node:path";
import { emptyBoard, type AiInfo, type Board, type BoardToHost, type ImageAiOp, type NoteCard } from "@codeboard/core";
import { runImageAi, SYS_FOCUS } from "@codeboard/host/testing";
import { put, type Host } from "../harness";
import { test, open, check, until, idle } from "../fixtures";

const SHOTS = process.env.AI_SHOTS;
const shoot = async (h: Host, name: string, el?: string) => {
  if (!SHOTS) return;
  await idle(h);
  if (el) await h.page.locator(el).first().screenshot({ path: path.join(SHOTS, name) });
  else await h.page.screenshot({ path: path.join(SHOTS, name) });
};
const sentOf = <T extends BoardToHost["type"]>(h: Host, t: T) => h.sent.filter((m): m is Extract<BoardToHost, { type: T }> => m.type === t);
const settingsSent = (h: Host) => sentOf(h, "setSetting").map((m) => `${m.key}=${JSON.stringify(m.value)}`);

const MODELS: AiInfo["models"] = [
  { id: "gpt-4o", name: "GPT-4o", vendor: "copilot", vision: true },
  { id: "o3-mini", name: "o3-mini", vendor: "copilot", vision: false },
];

test("aiSettingsSection", async () => {
  let key = false;
  const h = await open({
    light: true, w: 1280, h: 900, settings: { theme: "warm-ink" } as any,
    on: async (m, reply) => {
      if (m.type === "aiInfo") { await reply(m.req!, { key, models: MODELS }); return true; }
      if (m.type === "aiKey") { key = m.action === "set"; await reply(m.req!, { key, models: MODELS }); return true; }
      return false;
    },
  });
  await h.page.keyboard.press("Meta+Comma");
  const sec = h.page.locator('.settings [data-sec="ai"]');
  await sec.waitFor();
  await sec.evaluate((el) => el.scrollIntoView({ block: "start" }));
  const status = sec.locator(".st-ks");
  await until(h, "the key status is asked for", () => sentOf(h, "aiInfo").length);
  check("aiSettingsSection the key shows Not set, Clear is off", (await status.innerText()) === "Not set" && (await sec.locator("button", { hasText: "Clear" }).isDisabled()), await status.innerText());
  await sec.locator("button", { hasText: "Set Key…" }).click();
  await until(h, "the key shows Set", async () => (await status.innerText()) === "Set");
  check("aiSettingsSection Set Key… asks the host, which opens the password box", sentOf(h, "aiKey").map((m) => m.action).join() === "set" && !(await sec.locator("button", { hasText: "Clear" }).isDisabled()), sentOf(h, "aiKey"));
  const auto = await sec.locator('select[data-ai="aiText"] option[value="auto"]').innerText();
  check("aiSettingsSection Auto says it uses DeepSeek once a key is set", auto === "Auto (DeepSeek)", auto);
  const opts = async (k: string) => sec.locator(`select[data-ai="${k}"] option`).evaluateAll((os) => os.map((o) => `${(o as HTMLOptionElement).value}${(o as HTMLOptionElement).disabled ? "!" : ""}`));
  const svgOpts = await opts("aiSvg"), focusOpts = await opts("aiFocus");
  check("aiSettingsSection each tool offers Auto, DeepSeek and the VS Code models; the image tools not a model without image input",
    svgOpts.join() === "auto,deepseek,gpt-4o,o3-mini!" && focusOpts.join() === "auto,deepseek,gpt-4o,o3-mini", { svgOpts, focusOpts });
  await sec.locator('select[data-ai="aiSvg"]').selectOption("gpt-4o");
  await sec.locator('select[data-ai="aiFocus"]').selectOption("deepseek");
  await sec.locator(".st-chip", { hasText: "VS Code Model" }).click();
  await sec.locator(".st-dsm").fill("deepseek-vision");
  await sec.locator(".st-dsm").press("Enter");
  await sec.locator(".st-check", { hasText: "Think First" }).locator("input").check();
  await until(h, "five settings are sent", () => sentOf(h, "setSetting").length >= 5);
  await shoot(h, "59-ai-settings.png", '.settings [data-sec="ai"]');
  check("aiSettingsSection the choices are saved as settings", settingsSent(h).join(" ") === 'aiSvg="gpt-4o" aiFocus="deepseek" aiProvider="copilot" deepseekModel="deepseek-vision" svgThink=true', settingsSent(h));
  check("aiSettingsSection the page shows the saved choices", (await sec.locator('select[data-ai="aiSvg"]').inputValue()) === "gpt-4o" && (await sec.locator(".st-chip.on").innerText()) === "VS Code Model", await sec.locator(".st-chip.on").innerText());
  await sec.locator("button", { hasText: "Clear" }).click();
  await until(h, "the key shows Not set", async () => (await status.innerText()) === "Not set");
  check("aiSettingsSection Clear asks the host to remove the key", sentOf(h, "aiKey").map((m) => m.action).join() === "set,clear", sentOf(h, "aiKey"));
  await h.close();
});

const MD = "## Paged attention\n\nThe scheduler keeps the KV cache in fixed-size blocks, so memory is never copied. Run `step()` to advance.\n\n- A *block table* maps each sequence to its blocks.\n- Cost: $O(n)$ lookups per step.";
const MARKED = "## Paged attention\n\nThe ==scheduler== keeps the ==KV cache== in fixed-size blocks, so **memory is never copied**. Run `step()` to advance.\n\n- A *block table* maps each sequence to its ==blocks==.\n- Cost: $O(n)$ lookups per step.";

/** A Note on a board whose host answers imageAi with runImageAi on a fake DeepSeek; gate = hold the answer until released */
async function focusHost(answer: (op: ImageAiOp) => string, o: { gate?: Promise<void> } = {}) {
  const b: Board = emptyBoard("b1", "focus");
  b.cam = { x: 0, y: 0, z: 1 };
  put(b, { id: "n1", kind: "note", md: MD, look: "note" } as NoteCard, 80, 80, 460);
  const calls: any[] = [];
  const fetchFake = (async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    calls.push(body);
    await o.gate;
    const op: ImageAiOp = { kind: "focus", md: body.messages[1].content };
    return new Response(JSON.stringify({ choices: [{ finish_reason: "stop", message: { content: answer(op) } }] }), { status: 200 });
  }) as unknown as typeof fetch;
  const h = await open({
    board: b, light: true, w: 1100, h: 640, settings: { theme: "warm-ink" } as any,
    on: async (m, reply) => {
      if (m.type !== "imageAi") return false;
      try { await reply(m.req!, await runImageAi({ key: "sk-fake", fetch: fetchFake }, m.op)); } catch (e) { await reply(m.req!, undefined, (e as Error).message); }
      return true;
    },
  });
  await idle(h);
  return { h, calls };
}
const mdOf = (h: Host) => (h.board().cards.find((c) => c.id === "n1") as NoteCard).md;
async function menuOnNote(h: Host) {
  const r = (await h.page.locator('.card[data-id="n1"] .nbody').boundingBox())!;
  await h.page.mouse.click(r.x + r.width / 2, r.y + r.height - 12, { button: "right" });
  await h.page.locator(".ctx.open").first().waitFor();
  return h.page.locator(".ctx.open").last().locator("button .lb").allInnerTexts();
}

test("autoFocusNote", async () => {
  let release!: () => void;
  const gate = new Promise<void>((ok) => (release = ok));
  const { h, calls } = await focusHost(() => `<document>\n${MARKED}\n</document>`, { gate });
  await shoot(h, "55-autofocus-note-before.png", '.card[data-id="n1"]');
  const items = await menuOnNote(h);
  check("autoFocusNote the Note's menu has Auto Focus before Edit", items.indexOf("Auto Focus") >= 0 && items.indexOf("Auto Focus") === items.indexOf("Edit") - 1, items);
  await h.page.locator(".ctx.open button", { hasText: "Auto Focus" }).first().click();
  const busy = h.page.locator('.card[data-id="n1"] .aibusy');
  await busy.waitFor();
  check("autoFocusNote the card is busy with a Cancel while waiting", (await busy.innerText()).includes("Auto Focus…") && (await busy.locator("button", { hasText: "Cancel" }).count()) === 1, await busy.innerText());
  await until(h, "DeepSeek is asked", () => calls.length);
  const body = calls[0];
  check("autoFocusNote sends the rules and the Markdown, without thinking", body.messages[0].content === SYS_FOCUS && body.messages[1].content.includes(`<document>\n${MD}\n</document>`) && body.thinking?.type === "disabled", { thinking: body.thinking, user: String(body.messages[1].content).slice(0, 80) });
  release();
  await until(h, "the marks are written back", () => mdOf(h) === MARKED);
  await busy.waitFor({ state: "detached" });
  const card = h.page.locator('.card[data-id="n1"]');
  await until(h, "the marks are drawn", () => card.locator("mark").count());
  const marks = await card.locator("mark").allInnerTexts(), strong = await card.locator("strong").allInnerTexts();
  check("autoFocusNote the Note shows the highlights and the bold; code, formula and italics are as they were",
    marks.join("|") === "scheduler|KV cache|blocks" && strong.join("|") === "memory is never copied" && (await card.locator("code").innerText()) === "step()" && (await card.locator(".katex").count()) === 1 && (await card.locator("em").innerText()) === "block table", { marks, strong });
  check("autoFocusNote the notice counts the marks", (await h.page.locator(".toast").last().innerText()).includes("3 highlights and 1 bold mark"), await h.page.locator(".toast").last().innerText());
  await shoot(h, "55-autofocus-note-after.png", '.card[data-id="n1"]');
  await h.page.keyboard.press("Meta+z");
  await until(h, "undo brings the plain Note back", () => mdOf(h) === MD);
  check("autoFocusNote one undo brings the original Markdown back", mdOf(h) === MD, mdOf(h));
  await h.close();
});

test("autoFocusRejectsAlteredReply", async () => {
  // a word changed ("keeps" → "stores"), and a highlight inside the code span
  const altered = MARKED.replace("keeps", "stores");
  const inCode = MARKED.replace("`step()`", "`==step==()`");
  let n = 0;
  const { h, calls } = await focusHost(() => (n++ ? inCode : altered));
  for (const [i, what] of [[1, "a changed word"], [2, "a mark inside code"]] as const) {
    await menuOnNote(h);
    await h.page.locator(".ctx.open button", { hasText: "Auto Focus" }).first().click();
    await until(h, `the reply with ${what} is asked for`, () => calls.length >= i);
    // the busy layer goes when the answer is in; the check and its notice follow right away
    await h.page.locator('.card[data-id="n1"] .aibusy').waitFor({ state: "detached" });
    await idle(h);
    const toast = h.page.locator(".toast", { hasText: "the model changed the text, so nothing was applied" });
    check(`autoFocusRejectsAlteredReply a reply with ${what} is not applied, and the notice says why`, mdOf(h) === MD && (await toast.count()) > 0 && (await h.page.locator('.card[data-id="n1"] mark').count()) === 0, mdOf(h));
  }
  await h.page.keyboard.press("Meta+z");
  await idle(h);
  check("autoFocusRejectsAlteredReply there is no change to undo", mdOf(h) === MD && !!h.board().cards.find((c) => c.id === "n1"), mdOf(h));
  await h.close();
});
