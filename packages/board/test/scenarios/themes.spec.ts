// Theme looks (Ink Wash, City): npm run harness -- themeLooks [--light]; City roads, cars and traffic: cityTheme
import * as fs from "node:fs";
import * as path from "node:path";
import { shot, symCard, findSym, put, OUT } from "../harness";
import { emptyBoard, type Board } from "@codeboard/core";
import { test, open, check, light } from "../fixtures";

const card = (q: string) => { const s = findSym(q); return symCard(s.f, s.s); };

function board(): Board {
  const b = emptyBoard("b1", "nano-vllm · looks");
  const step = card("LLMEngine.step"), sch = card("Scheduler.schedule"), run = card("ModelRunner.run");
  put(b, step, 80, 120, 560); put(b, sch, 760, 60, 480); put(b, run, 760, 460, 480);
  const s0 = step.segments[0];
  const at = (re: RegExp) => s0.start + s0.text.findIndex((t) => re.test(t));
  b.links.push({ id: "L1", kind: "call", from: { card: step.id, seg: s0.id, line: at(/scheduler\.schedule\(/) }, to: { card: sch.id }, call: { name: "schedule", col: 37 }, vars: [{ a: "seqs", ret: true }] } as any);
  b.links.push({ id: "L2", kind: "call", from: { card: step.id, seg: s0.id, line: at(/model_runner\.call\(/) }, to: { card: run.id }, call: { name: "call", col: 37 } } as any);
  b.cam = { x: 0, y: 0, z: 1 };
  return b;
}

const STROKE: Record<string, string> = { "ink-wash": "1px", city: "2px" };

/** City: every arrow end is a parked car (merged ends: one car per junction) waiting at a zebra crossing, main roads have a shoulder,
 *  white edge lines and a double yellow centre line, small streets a white centre line,
 *  traffic off = no animation at all; on = cars driving (transform / opacity only, compositor); reduced motion = off. Screenshots to SHOTS */
test("cityTheme", async () => {
  const SHOTS = process.env.CITY_SHOTS ?? path.join(OUT, "themes");
  try { fs.mkdirSync(SHOTS, { recursive: true }); } catch { /* no project files here: harness output only */ }
  for (const light of [true, false]) {
    const b = board();
    const run = b.cards[2], loop = card("ModelRunner.loop"), s1 = loop.segments[0];
    put(b, loop, 80, 640, 520);
    b.links.push({ id: "L3", from: { card: loop.id, seg: s1.id, line: s1.start + s1.text.findIndex((t) => /self\.call\(/.test(t)) }, to: { card: run.id }, call: { name: "call", col: 16 } } as any);
    b.links.push({ id: "P1", from: { card: b.cards[1].id }, to: { card: loop.id } } as any);
    (b.links[0] as any).call.vars = [{ a: "seqs", ret: true }]; // a green guide sign on L1
    b.cam = { x: 0, y: 0, z: 0.85 };
    const h = await open({ board: b, light, w: 1300, h: 900, settings: { theme: "city" } as any });
    await h.page.waitForTimeout(800);
    const probe = () => h.page.evaluate(() => {
      const links = [...document.querySelectorAll<SVGGElement>("g.link")];
      const running = document.getAnimations().filter((a) => a.playState === "running" && a.effect?.getComputedTiming().iterations === Infinity);
      return {
        cars: Object.fromEntries(links.map((g) => [g.dataset.lk, g.querySelectorAll(".ahead.end.car").length])),
        merged: links.filter((g) => g.dataset.merged !== undefined).map((g) => g.dataset.lk),
        merges: [...document.querySelectorAll<SVGGElement>("g.merge")].map((g) => ({ n: g.dataset.n, cars: g.querySelectorAll(".ahead.end.car").length, lanes: g.querySelectorAll(".lane").length })),
        rot: document.querySelector('g.link[data-lk="L1"] .ahead.end')?.getAttribute("data-deg") ?? "",
        casings: document.querySelectorAll(".casings .casing").length,
        lanes: document.querySelectorAll("g.link .lane").length,
        kerbs: document.querySelectorAll(".kerbs .kerb").length,
        clines: document.querySelectorAll("g.link .cline").length,
        zebra: [...document.querySelectorAll(".ahead.end.car .clamp")].map((p) => (p.getAttribute("d")!.match(/Z/g) ?? []).length - 2),
        carColor: (() => { const u = document.querySelector(".ahead.end.car"); return u ? getComputedStyle(u).getPropertyValue("--car-c").trim() : ""; })(),
        movers: document.querySelectorAll(".movers .mover").length,
        running: running.length,
        compOnly: running.every((a) => (a.effect as KeyframeEffect).getKeyframes().every((k) => Object.keys(k).every((p) => ["offset", "easing", "composite", "computedOffset", "transform", "opacity"].includes(p)))),
      };
    });
    const off = await probe();
    await shot(h, `city-${light ? "light" : "dark"}-off`);
    try { await h.page.screenshot({ path: `${SHOTS}/city-${light ? "light" : "dark"}-off.png` }); } catch { /* ignore */ }
    await h.page.locator(".dock .traffic").click(); await h.page.mouse.move(5, 500); await h.page.waitForTimeout(1500);
    const on = await probe();
    await shot(h, `city-${light ? "light" : "dark"}-on`);
    try { await h.page.screenshot({ path: `${SHOTS}/city-${light ? "light" : "dark"}-on.png` }); } catch { /* ignore */ }
    await h.page.locator(".dock .traffic").click(); await h.page.waitForTimeout(200);
    const back = await probe();
    await h.page.emulateMedia({ reducedMotion: "reduce" });
    await h.page.locator(".dock .traffic").click(); await h.page.waitForTimeout(300);
    const reduced = await probe();
    const ok = off.cars.L1 === 1 && off.cars.L2 === 0 && off.cars.L3 === 0 && off.cars.P1 === 1 && off.merged.sort().join() === "L2,L3"
      && off.merges.length === 1 && off.merges[0].n === "2" && off.merges[0].cars === 1 && off.merges[0].lanes === 1
      && off.rot === "0" && off.casings === 5 && off.lanes === 3 && off.kerbs === 4 && off.clines === 1 && off.zebra.sort().join() === "3,4,4" && !!off.carColor
      && off.movers === 0 && off.running === 0
      && on.movers >= 4 && on.running === 2 * on.movers && on.compOnly
      && back.movers === 0 && back.running === 0 && reduced.movers === 0 && reduced.running === 0;
    check("cityTheme", ok, light ? "light" : "dark", JSON.stringify({ off, on: { movers: on.movers, running: on.running, compOnly: on.compOnly }, back: back.running, reduced: reduced.running }));
    await h.page.context().close();
    // Close-up of the junction and the parked cars (road markings, zebra crossings): screenshot only
    b.cam = { x: -1050, y: -1200, z: 2.5 };
    const z = await open({ board: b, light, w: 1300, h: 900, settings: { theme: "city" } as any });
    await z.page.waitForTimeout(800);
    await shot(z, `city-${light ? "light" : "dark"}-zoom`);
    try { await z.page.screenshot({ path: `${SHOTS}/city-${light ? "light" : "dark"}-zoom.png` }); } catch { /* ignore */ }
    await z.page.context().close();
  }
});

/** Each new look in light and dark: per-file hue on code cards, icon stroke 1 or 2 px, scene backgrounds,
 *  the City traffic light (only in City, red by default), and no endless animation running */
test("themeLooks", async () => {
  for (const light of [true, false]) for (const theme of Object.keys(STROKE)) {
    const h = await open({ board: board(), light, w: 1300, h: 820, settings: { theme } as any });
    await h.page.waitForTimeout(800);
    const r = await h.page.evaluate(() => {
      const cards = [...document.querySelectorAll<HTMLElement>(".card.ccard")];
      const endless = () => document.getAnimations().filter((a) => a.playState === "running" && a.effect?.getComputedTiming().iterations === Infinity).length;
      const head = (i: number) => getComputedStyle(cards[i].querySelector(".chead")!).backgroundColor;
      return {
        look: document.documentElement.dataset.look,
        heads: [head(0), head(1)],
        stroke: getComputedStyle(document.querySelector(".bbar .ico")!).strokeWidth,
        scene: getComputedStyle(document.querySelector(".board")!).backgroundImage.includes("data:image/svg"),
        traffic: document.querySelectorAll(".dock .traffic").length,
        pressed: document.querySelector(".dock .traffic")?.getAttribute("aria-pressed") ?? null,
        endless: endless(),
      };
    });
    let toggled = null as string | null, endlessOn = 0;
    if (r.traffic) {
      await h.page.locator(".dock .traffic").click(); await h.page.waitForTimeout(300);
      toggled = await h.page.locator(".dock .traffic").getAttribute("aria-pressed");
      endlessOn = await h.page.evaluate(() => document.getAnimations().filter((a) => a.playState === "running" && a.effect?.getComputedTiming().iterations === Infinity).length);
      await h.page.locator(".dock .traffic").click(); await h.page.mouse.move(5, 500); await h.page.waitForTimeout(200);
    }
    await shot(h, `look-${theme}-${light ? "light" : "dark"}`);
    const ok = r.look === theme
      && r.stroke === STROKE[theme] && r.endless === 0 && (theme === "city" ? endlessOn > 0 : endlessOn === 0)
      && (theme === "ink-wash" || theme === "city" ? r.scene : true)
      && (theme === "city" ? r.traffic === 1 && r.pressed === "false" && toggled === "true" : r.traffic === 0);
    check("theme-look", ok, theme, light ? "light" : "dark", JSON.stringify(r), toggled ?? "");
    await h.page.context().close();
  }
});

/** Corners: rounded boxes use continuous-curvature (squircle) corners from one token (--corner); circles and pills stay round.
 *  Screenshots: the board with a Section, a Note and a menu, and card corners close up (squircle-*) */
test("squircleCorners", async () => {
  const b = board();
  b.cards.push({ id: "n1", kind: "note", bg: true, md: "# Corners\n\nSmooth, continuous curvature." } as any);
  b.place.n1 = { x: 80, y: 600, w: 320 };
  b.sections.push({ id: "S1", title: "Engine", x: 50, y: 70, w: 620, h: 470 });
  b.place[b.cards[0].id].section = "S1";
  const h = await open({ board: b, light, w: 1400, h: 900 });
  await h.page.waitForTimeout(900);
  const css = await h.page.evaluate(() => {
    const cs = (sel: string) => { const e = document.querySelector(sel); return e ? getComputedStyle(e).getPropertyValue("corner-top-left-shape") : null; };
    return { supported: CSS.supports("corner-shape", "squircle"), card: cs(".card"), head: cs(".card .chead"), sect: cs(".sect"), bar: cs(".bbar"), menu: cs(".ctx"), dot: cs(".chead .rev .rl") && getComputedStyle(document.querySelector(".chead .rev .rl")!, "::before").getPropertyValue("corner-top-left-shape") };
  });
  await h.page.locator('.card[data-id="n1"] .chead').click({ button: "right" }); await h.page.waitForTimeout(400);
  const menu = await h.page.evaluate(() => getComputedStyle(document.querySelector(".ctx")!).getPropertyValue("corner-top-left-shape"));
  await shot(h, "squircle-01-board");
  await h.page.keyboard.press("Escape"); await h.page.mouse.click(1200, 820); await h.page.mouse.move(1300, 850); await h.page.waitForTimeout(500);
  const r = (await h.page.locator('.card[data-id="n1"]').boundingBox())!;
  await h.page.screenshot({ path: path.join(OUT, "squircle-02-note-corner.png"), clip: { x: r.x - 8, y: r.y + r.height - 40, width: 48, height: 48 } });
  const r2 = (await h.page.locator(".card.ccard").nth(1).boundingBox())!;
  await h.page.screenshot({ path: path.join(OUT, "squircle-03-code-corner.png"), clip: { x: r2.x + r2.width - 40, y: r2.y - 8, width: 48, height: 48 } });
  const smooth = (v: string | null) => !!v && v !== "round" && v !== "superellipse(1)";
  check("squircle-corners", !css.supported || (smooth(css.card) && smooth(css.head) && smooth(css.sect) && smooth(css.bar) && smooth(menu) && !smooth(css.dot)), { ...css, menu });
  await h.page.context().close();
});

/** ··· More → Theme: a submenu of every theme with the current one checked; picking one switches the look at once and saves it
 *  as the same setting the Settings page uses. Keyboard: ↓ to Theme, → opens the submenu on its first item, ← closes it,
 *  Esc closes only the submenu, ↵ picks. Screenshots to THEME_SHOTS (default test-out/harness/themes) */
test("themeMenuSwitchesTheme", async () => {
  const SHOTS = process.env.THEME_SHOTS ?? path.join(OUT, "themes");
  try { fs.mkdirSync(SHOTS, { recursive: true }); } catch { /* harness output only */ }
  const h = await open({ board: board(), light: true, w: 1300, h: 820, settings: { theme: "warm-ink" } as never });
  const pg = h.page;
  await pg.waitForTimeout(500);
  const menus = () => pg.locator(".ctx").count();
  const first = () => pg.locator(".ctx").first();
  const sub = () => pg.locator(".ctx").nth(1);
  const items = (m: ReturnType<typeof sub>) => m.locator("button[role=menuitem]").evaluateAll((bs) => bs.map((b) => ({
    label: b.querySelector(".lb")!.textContent, checked: !!b.querySelector(".ck svg"), kb: b.classList.contains("kb"), off: (b as HTMLButtonElement).disabled })));
  const look = () => pg.evaluate(() => document.documentElement.dataset.look);
  const themeSet = () => h.sent.filter((m) => m.type === "setSetting" && (m as { key: string }).key === "theme").map((m) => (m as { value: string }).value);
  const more = async () => { await pg.locator('.bbar button[aria-label="More"]').click(); await pg.waitForTimeout(350); };
  const res: Record<string, unknown> = {};

  // 鼠标：悬停 Theme 打开二级菜单，当前主题打勾；点 Graphite 立刻换
  await more();
  const tops = await items(first()), labels = tops.map((t) => t.label);
  res.afterSettings = labels[labels.indexOf("Settings…") + 1];
  await first().locator("button[role=menuitem]", { hasText: /^Theme$/ }).hover();
  await pg.waitForTimeout(400);
  res.hoverMenus = await menus();
  const subItems = await items(sub());
  res.subItems = subItems;
  res.subOpen = await sub().evaluate((e) => e.classList.contains("open"));
  await sub().locator("button", { hasText: "Ink Wash" }).hover();
  await pg.waitForTimeout(150);
  await pg.screenshot({ path: path.join(SHOTS, "theme-menu-light.png") });
  await sub().locator("button", { hasText: /^Graphite$/ }).click();
  await pg.waitForTimeout(300);
  res.clicked = { menus: await menus(), look: await look(), set: themeSet() };

  // 键盘：↓ 走到 Theme，→ 打开（选中第一项），← 关回来；→ 再开，Esc 只关二级；→ 再开，↓ 走到 Poster，↵ 换
  await pg.mouse.move(5, 5);
  await more();
  const steps = tops.slice(0, labels.indexOf("Theme") + 1).filter((t) => !t.off).length; // ↓ skips disabled items (Redo)
  for (let i = 0; i < steps; i++) await pg.keyboard.press("ArrowDown");
  res.kbOnTheme = (await items(first())).find((t) => t.kb)?.label;
  await pg.keyboard.press("ArrowRight");
  await pg.waitForTimeout(350);
  const right = { menus: await menus(), firstKb: (await items(sub()))[0]?.kb };
  res.right = right;
  await pg.keyboard.press("ArrowLeft");
  await pg.waitForTimeout(150);
  res.left = { menus: await menus(), kb: (await items(first())).find((t) => t.kb)?.label };
  await pg.keyboard.press("ArrowRight");
  await pg.waitForTimeout(350);
  await pg.keyboard.press("Escape");
  await pg.waitForTimeout(150);
  res.esc = { menus: await menus() };
  await pg.keyboard.press("ArrowRight");
  await pg.waitForTimeout(350);
  const now = await items(sub());
  for (let i = 0; i < now.findIndex((t) => t.label === "Poster"); i++) await pg.keyboard.press("ArrowDown");
  res.kbOnPoster = (await items(sub())).find((t) => t.kb)?.label;
  await pg.keyboard.press("Enter");
  await pg.waitForTimeout(300);
  res.entered = { menus: await menus(), look: await look(), set: themeSet() };
  // 再打开：勾跟着换到 Poster
  await more();
  await first().locator("button[role=menuitem]", { hasText: /^Theme$/ }).hover();
  await pg.waitForTimeout(400);
  res.checkedNow = (await items(sub())).filter((t) => t.checked).map((t) => t.label);
  await pg.keyboard.press("Escape");
  await pg.keyboard.press("Escape");
  await pg.waitForTimeout(200);
  res.closed = await menus();

  const names = ["Warm Ink", "Graphite", "Soft Light", "Drafting", "Colorful", "Newspaper", "Poster", "Classic", "Ink Wash", "City"];
  const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
  check("themeMenu-listsThemes", res.afterSettings === "Theme" && res.hoverMenus === 2 && res.subOpen === true
    && same(subItems.map((t) => t.label), names) && subItems.filter((t) => t.checked).map((t) => t.label).join() === "Warm Ink", res);
  check("themeMenu-clickSwitches", same(res.clicked, { menus: 0, look: "graphite", set: ["graphite"] }), res);
  check("themeMenu-keyboard", res.kbOnTheme === "Theme" && right.menus === 2 && right.firstKb === true
    && same(res.left, { menus: 1, kb: "Theme" }) && same(res.esc, { menus: 1 })
    && res.kbOnPoster === "Poster" && same(res.entered, { menus: 0, look: "poster", set: ["graphite", "poster"] }), res);
  check("themeMenu-checksCurrent", (res.checkedNow as string[]).join() === "Poster" && res.closed === 0, res);
  await pg.context().close();
});
