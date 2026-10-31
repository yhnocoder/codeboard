import * as fs from "node:fs";
import * as path from "node:path";
import { shot, symCard, findSym, put, OUT } from "../harness";
import { emptyBoard, type Board } from "@codeboard/core";
import { test, open, check, light, idle } from "../fixtures";

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
    await idle(h);
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
    await h.page.locator(".dock .traffic").click(); await h.page.mouse.move(5, 500);
    // the cars come with the green light, on the roads picked once the camera is still
    await h.page.locator('.dock .traffic[aria-pressed="true"]').waitFor(); await idle(h);
    const on = await probe();
    await shot(h, `city-${light ? "light" : "dark"}-on`);
    try { await h.page.screenshot({ path: `${SHOTS}/city-${light ? "light" : "dark"}-on.png` }); } catch { /* ignore */ }
    await h.page.locator(".dock .traffic").click();
    await h.page.locator('.dock .traffic[aria-pressed="false"]').waitFor(); await idle(h);
    const back = await probe();
    await h.page.emulateMedia({ reducedMotion: "reduce" });
    await h.page.locator(".dock .traffic").click();
    await h.page.locator('.dock .traffic[aria-pressed="true"]').waitFor(); await idle(h);
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
    await idle(h);
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
      await h.page.locator(".dock .traffic").click(); await idle(h);
      toggled = await h.page.locator(".dock .traffic").getAttribute("aria-pressed");
      endlessOn = await h.page.evaluate(() => document.getAnimations().filter((a) => a.playState === "running" && a.effect?.getComputedTiming().iterations === Infinity).length);
      await h.page.locator(".dock .traffic").click(); await h.page.mouse.move(5, 500);
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
  b.cards.push({ id: "n1", kind: "note", look: "note", md: "# Corners\n\nSmooth, continuous curvature." } as any);
  b.place.n1 = { x: 80, y: 600, w: 320 };
  b.sections.push({ id: "S1", title: "Engine", x: 50, y: 70, w: 620, h: 470 });
  b.place[b.cards[0].id].section = "S1";
  const h = await open({ board: b, light, w: 1400, h: 900 });
  await idle(h);
  const css = await h.page.evaluate(() => {
    const cs = (sel: string) => { const e = document.querySelector(sel); return e ? getComputedStyle(e).getPropertyValue("corner-top-left-shape") : null; };
    return { supported: CSS.supports("corner-shape", "squircle"), card: cs(".card"), head: cs(".card .chead"), sect: cs(".sect"), bar: cs(".bbar"), menu: cs(".ctx"), dot: cs(".chead .rev .rl") && getComputedStyle(document.querySelector(".chead .rev .rl")!, "::before").getPropertyValue("corner-top-left-shape") };
  });
  await h.page.locator('.card[data-id="n1"] .chead').click({ button: "right" }); await h.page.locator(".ctx").waitFor();
  const menu = await h.page.evaluate(() => getComputedStyle(document.querySelector(".ctx")!).getPropertyValue("corner-top-left-shape"));
  await shot(h, "squircle-01-board");
  await h.page.keyboard.press("Escape"); await h.page.mouse.click(1200, 820); await h.page.mouse.move(1300, 850); await idle(h);
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
  await idle(h);
  const menus = () => pg.locator(".ctx").count();
  const first = () => pg.locator(".ctx").first();
  const sub = () => pg.locator(".ctx").nth(1);
  const items = (m: ReturnType<typeof sub>) => m.locator("button[role=menuitem]").evaluateAll((bs) => bs.map((b) => ({
    label: b.querySelector(".lb")!.textContent, checked: !!b.querySelector(".ck svg"), kb: b.classList.contains("kb"), off: (b as HTMLButtonElement).disabled })));
  const look = () => pg.evaluate(() => document.documentElement.dataset.look);
  const themeSet = () => h.sent.filter((m) => m.type === "setSetting" && (m as { key: string }).key === "theme").map((m) => (m as { value: string }).value);
  const more = async () => { await pg.locator('.bbar button[aria-label="More"]').click(); await first().waitFor(); await idle(h); };
  const res: Record<string, unknown> = {};

  // 鼠标：悬停 Theme 打开二级菜单，当前主题打勾；点 Graphite 立刻换
  await more();
  const tops = await items(first()), labels = tops.map((t) => t.label);
  res.afterSettings = labels[labels.indexOf("Settings…") + 1];
  await first().locator("button[role=menuitem]", { hasText: /^Theme$/ }).hover();
  await idle(h); // the submenu opens on pointerenter
  res.hoverMenus = await menus();
  const subItems = await items(sub());
  res.subItems = subItems;
  res.subOpen = await sub().evaluate((e) => e.classList.contains("open"));
  await sub().locator("button", { hasText: "Ink Wash" }).hover();
  await idle(h);
  await pg.screenshot({ path: path.join(SHOTS, "theme-menu-light.png") });
  await sub().locator("button", { hasText: /^Graphite$/ }).click();
  await idle(h);
  res.clicked = { menus: await menus(), look: await look(), set: themeSet() };

  // 键盘：↓ 走到 Theme，→ 打开（选中第一项），← 关回来；→ 再开，Esc 只关二级；→ 再开，↓ 走到 Poster，↵ 换
  await pg.mouse.move(5, 5);
  await more();
  const steps = tops.slice(0, labels.indexOf("Theme") + 1).filter((t) => !t.off).length; // ↓ skips disabled items (Redo)
  for (let i = 0; i < steps; i++) await pg.keyboard.press("ArrowDown");
  res.kbOnTheme = (await items(first())).find((t) => t.kb)?.label;
  await pg.keyboard.press("ArrowRight");
  await idle(h);
  const right = { menus: await menus(), firstKb: (await items(sub()))[0]?.kb };
  res.right = right;
  await pg.keyboard.press("ArrowLeft");
  await idle(h);
  res.left = { menus: await menus(), kb: (await items(first())).find((t) => t.kb)?.label };
  await pg.keyboard.press("ArrowRight");
  await idle(h);
  await pg.keyboard.press("Escape");
  await idle(h);
  res.esc = { menus: await menus() };
  await pg.keyboard.press("ArrowRight");
  await idle(h);
  const now = await items(sub());
  for (let i = 0; i < now.findIndex((t) => t.label === "Poster"); i++) await pg.keyboard.press("ArrowDown");
  res.kbOnPoster = (await items(sub())).find((t) => t.kb)?.label;
  await pg.keyboard.press("Enter");
  await idle(h);
  res.entered = { menus: await menus(), look: await look(), set: themeSet() };
  // 再打开：勾跟着换到 Poster
  await more();
  await first().locator("button[role=menuitem]", { hasText: /^Theme$/ }).hover();
  await idle(h); // the submenu opens on pointerenter
  res.checkedNow = (await items(sub())).filter((t) => t.checked).map((t) => t.label);
  await pg.keyboard.press("Escape");
  await pg.keyboard.press("Escape");
  await idle(h);
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

/** Menus open from the click point with a short ease-out: scale .97 → 1 and a fade, never past 1 (no spring overshoot),
 *  settled within about 200 ms. Checked on the ··· More menu and on its Theme submenu, sampled every frame */
test("menuOpensWithoutOvershoot", async () => {
  const h = await open({ board: board(), light: true, w: 1300, h: 820 });
  const pg = h.page;
  await idle(h);
  type S = { t: number; s: number; o: number };
  // from the frame the action runs: the newest menu's scale and opacity every frame for 400 ms (t = ms since the action)
  const sample = async (act: () => Promise<void>) => {
    await pg.evaluate(() => {
      const w = window as unknown as { __menuSamples: Promise<S[]>; __menuGo: () => void };
      const n0 = document.querySelectorAll(".ctx").length;
      let go!: () => void;
      const started = new Promise<void>((r) => { go = r; });
      w.__menuGo = go;
      w.__menuSamples = started.then(async () => {
        const out: S[] = [], t0 = performance.now();
        while (performance.now() - t0 < 400) {
          await new Promise(requestAnimationFrame);
          const ms = document.querySelectorAll<HTMLElement>(".ctx");
          if (ms.length <= n0) continue;
          const cs = getComputedStyle(ms[ms.length - 1]);
          out.push({ t: Math.round(performance.now() - t0), s: cs.scale === "none" ? 1 : parseFloat(cs.scale), o: +cs.opacity });
        }
        return out;
      });
    });
    await pg.evaluate(() => (window as unknown as { __menuGo: () => void }).__menuGo());
    await act();
    return pg.evaluate(() => (window as unknown as { __menuSamples: Promise<S[]> }).__menuSamples);
  };
  const summary = (xs: S[]) => {
    const settled = xs.find((_, i) => xs.slice(i).every((y) => y.s === 1 && y.o === 1));
    // settledAt: ms from the menu's first frame on screen (the click itself takes a moment to reach the page)
    return { frames: xs.length, first: xs[0], maxScale: Math.max(...xs.map((x) => x.s)), minScale: Math.min(...xs.map((x) => x.s)), settledAt: settled ? settled.t - xs[0].t : null };
  };
  const top = summary(await sample(() => pg.locator('.bbar button[aria-label="More"]').click()));
  await pg.locator(".ctx").first().locator("button[role=menuitem]", { hasText: /^Theme$/ }).hover();
  await idle(h); // the submenu opens on pointerenter
  await pg.keyboard.press("ArrowLeft"); // closes only the submenu; → opens it again
  await idle(h);
  const sub = summary(await sample(() => pg.keyboard.press("ArrowRight")));
  const ok = (m: ReturnType<typeof summary>) => m.frames > 3 && m.maxScale <= 1 && m.minScale >= 0.96 && m.settledAt !== null && m.settledAt <= 200;
  check("menuOpen-noOvershoot", ok(top), top);
  check("menuOpen-submenuNoOvershoot", ok(sub), sub);
  await pg.context().close();
});

/** Settings → Theme → Use VS Code's Background: in every theme the canvas takes VS Code's editor background
 *  (--vscode-editor-background, set on <html> here as VS Code does in the webview) at once, cards keep the theme's surface,
 *  pattern themes keep their pattern on top (Poster grid, City streets, Ink Wash hills); a VS Code theme change follows live;
 *  without the VS Code variable the theme's own background stays; turning it off restores the theme's background */
test("vscodeBackgroundSetting", async () => {
  const VS = "rgb(58, 61, 65)", VS2 = "rgb(30, 31, 34)";
  const h = await open({ board: board(), light: true, w: 1300, h: 820, settings: { theme: "warm-ink" } as never });
  const pg = h.page;
  await pg.evaluate((c) => document.documentElement.style.setProperty("--vscode-editor-background", c), VS);
  await idle(h);
  const probe = () => pg.evaluate(() => {
    const board = getComputedStyle(document.querySelector(".board")!), root = getComputedStyle(document.documentElement);
    const probeBg = document.createElement("div"); probeBg.style.color = root.getPropertyValue("--bg"); document.body.append(probeBg);
    const themeBg = getComputedStyle(probeBg).color; probeBg.remove();
    return { look: document.documentElement.dataset.look, bg: board.backgroundColor, image: board.backgroundImage, themeBg,
      card: getComputedStyle(document.querySelector(".card.ccard")!).backgroundColor };
  });
  const before = await probe();
  await pg.keyboard.press("Meta+Comma");
  await pg.waitForSelector(".settings");
  await pg.locator(".settings label.st-check", { hasText: "Use VS Code's Background" }).click();
  await idle(h);
  const on = await probe();
  const sentNow = () => h.sent.filter((m) => m.type === "setSetting" && (m as { key: string }).key === "vscodeBg").map((m) => (m as { value: boolean }).value);
  const sent = sentNow();
  // every theme, switched live from the Settings page
  const looks: Record<string, Awaited<ReturnType<typeof probe>>> = {};
  for (const sw of await pg.locator(".settings .st-sw").all()) {
    await sw.click(); await idle(h);
    const r = await probe(); looks[r.look!] = r;
  }
  await pg.locator(".settings .st-sw", { hasText: "Warm Ink" }).click();
  await pg.evaluate((c) => document.documentElement.style.setProperty("--vscode-editor-background", c), VS2);
  await idle(h);
  const live = await probe();
  await pg.evaluate(() => document.documentElement.style.removeProperty("--vscode-editor-background"));
  await idle(h);
  const noVar = await probe();
  await pg.evaluate((c) => document.documentElement.style.setProperty("--vscode-editor-background", c), VS);
  await pg.locator(".settings label.st-check", { hasText: "Use VS Code's Background" }).click();
  await idle(h);
  const off = await probe();
  const pattern: Record<string, (img: string) => boolean> = { poster: (i) => i.includes("linear-gradient"), city: (i) => i.includes("linear-gradient") && i.includes("url("), "ink-wash": (i) => i.includes("url(") };
  const bad = Object.entries(looks).filter(([id, r]) => r.bg !== VS || r.card === VS || (pattern[id] && !pattern[id](r.image))).map(([id]) => id);
  check("vscodeBackground-offByDefault", before.bg === before.themeBg && before.bg !== VS, before);
  check("vscodeBackground-switchesOn", on.bg === VS && on.card === before.card && sent.join() === "true", { on, sent });
  check("vscodeBackground-everyTheme", Object.keys(looks).length >= 10 && bad.length === 0, { bad, looks });
  check("vscodeBackground-followsVSCode", live.bg === VS2 && noVar.bg === noVar.themeBg, { live, noVar });
  check("vscodeBackground-switchesOff", off.bg === off.themeBg && off.bg !== VS && sentNow().join() === "true,false", { off, sent: sentNow() });
  await pg.context().close();
});

/** The bottom-right resize grip is concentric with the card's rounded corner in every theme (code card and Note): its arc
 *  has the same centre as the card's corner arc and every point of it stays inside the card, at least 1px from the edge; a card
 *  with (almost) square corners gets a square grip.
 *  Also: Soft Light's header icons (···) use the header's text colour */
test("resizeGripInsideCardCorner", async () => {
  const b = board();
  b.cards.push({ id: "n1", kind: "note", look: "note", md: "# Corner\n\nThe resize grip follows the card's corner." } as any);
  b.place.n1 = { x: 80, y: 560, w: 360 };
  const h = await open({ board: b, light: true, w: 1300, h: 820, settings: { theme: "warm-ink" } as never });
  const pg = h.page;
  await idle(h);
  const geo = () => pg.evaluate(() => [...document.querySelectorAll<HTMLElement>(".card")].flatMap((card) => {
    const grip = card.querySelector<HTMLElement>(":scope > .cface > .grip");
    if (!grip) return [];
    const W = card.offsetWidth, H = card.offsetHeight, cs = getComputedStyle(card);
    const r = Math.min(parseFloat(cs.borderBottomRightRadius) || 0, W / 2, H / 2);
    const a = getComputedStyle(grip, "::after");
    const w = parseFloat(a.width), hh = parseFloat(a.height);
    const R = Math.min(parseFloat(a.borderBottomRightRadius) || 0, w, hh);
    // the grip's box in card pixels (the canvas is scaled: divide screen pixels by the zoom)
    const cr = card.getBoundingClientRect(), gr = grip.getBoundingClientRect(), z = cr.width / W;
    const cx = (gr.right - cr.left) / z - parseFloat(a.right), cy = (gr.bottom - cr.top) / z - parseFloat(a.bottom);
    const gc = [cx - R, cy - R], cc = [W - r, H - r];
    let worst = Infinity;
    for (let i = 0; i <= 18; i++) {
      const t = (i / 18) * Math.PI / 2, x = gc[0] + R * Math.cos(t), y = gc[1] + R * Math.sin(t);
      const m = x > cc[0] && y > cc[1] ? r - Math.hypot(x - cc[0], y - cc[1]) : Math.min(W - x, H - y);
      worst = Math.min(worst, m);
    }
    return [{ id: card.dataset.id, r, R: +R.toFixed(2), off: +Math.hypot(gc[0] - cc[0], gc[1] - cc[1]).toFixed(2), margin: +worst.toFixed(2) }];
  }));
  await pg.keyboard.press("Meta+Comma");
  await pg.waitForSelector(".settings");
  const res: Record<string, Awaited<ReturnType<typeof geo>>> = {};
  let head = null as null | { icon: string; title: string };
  for (const sw of await pg.locator(".settings .st-sw").all()) {
    await sw.click(); await idle(h);
    const look = await pg.evaluate(() => document.documentElement.dataset.look!);
    res[look] = await geo();
    if (look === "soft-light") head = await pg.evaluate(() => {
      const hd = document.querySelector('.card[data-id="n1"] .chead')!;
      return { icon: getComputedStyle(hd.querySelector(".ib")!).color, title: getComputedStyle(hd.querySelector(".ctitle")!).color };
    });
  }
  const bad = Object.entries(res).flatMap(([look, gs]) => gs.filter((g) => (g.R > 0 ? g.off > 0.6 : g.r >= 4) || g.margin < 1).map((g) => ({ look, ...g })));
  check("resizeGrip-concentricInsideCorner", Object.keys(res).length >= 10 && Object.values(res).every((g) => g.length >= 2) && bad.length === 0, { bad, res });
  check("softLight-headerIconsMatchTitle", !!head && head.icon === head.title, head);
  await pg.context().close();
});

/** A Note or Text card keeps its own corner radius (--cr) while it is being edited, in Soft Light (large corners) and Warm Ink */
test("editingKeepsCardCorners", async () => {
  for (const theme of ["soft-light", "warm-ink"]) {
    const b = emptyBoard("b1", "corners");
    b.cards.push({ id: "n1", kind: "note", look: "note", md: "# Corners\n\nThe card keeps its rounded corners while editing." } as any);
    b.place.n1 = { x: 80, y: 80, w: 360 };
    b.cam = { x: 0, y: 0, z: 1 };
    const h = await open({ board: b, light: true, w: 900, h: 600, settings: { theme } as never });
    const pg = h.page;
    await idle(h);
    const radius = () => pg.evaluate(() => {
      const c = document.querySelector<HTMLElement>('.card[data-id="n1"]')!, cs = getComputedStyle(c);
      return { r: cs.borderTopLeftRadius, br: cs.borderBottomRightRadius, cr: cs.getPropertyValue("--cr").trim(), editing: c.classList.contains("editing"), cursor: cs.cursor };
    });
    const rest = await radius();
    await pg.locator('.card[data-id="n1"] .nbody p').last().dblclick();
    await pg.waitForSelector('.card[data-id="n1"] .md-pm', { timeout: 5000 });
    await pg.mouse.move(5, 5);
    await idle(h);
    const edit = await radius();
    await pg.screenshot({ path: path.join(OUT, `editingCorners-${theme}.png`), clip: { x: 40, y: 40, width: 480, height: 320 } });
    check(`editingKeepsCardCorners-${theme}`, edit.editing && parseFloat(rest.r) >= 10 && edit.r === rest.r && edit.br === rest.br && edit.cursor === rest.cursor, { idle: rest, edit });
    await pg.context().close();
  }
});

/** Soft Light: a Note's body text is regular weight (Jost and the CJK fallback both have a 400), not the light 300 that read too thin;
 *  bold stays bold, and a Text card's body is unchanged. Screenshots of both in Soft Light, and the Note in Warm Ink to compare */
test("softLightNoteBodyWeight", async () => {
  const b = emptyBoard("b1", "weights");
  b.cards.push({ id: "n1", kind: "note", look: "note", md: "在 **thread block cluster** 层次，CUDA 通过 Cooperative Groups API 提供 cluster 范围同步机制。The grid waits at the barrier." } as any);
  b.place.n1 = { x: 60, y: 60, w: 476 };
  b.cards.push({ id: "t1", kind: "note", look: "text", size: "body", md: "Text 卡的正文 · body text" } as any);
  b.place.t1 = { x: 60, y: 300, w: 544 };
  b.cam = { x: 0, y: 0, z: 1 };
  const weights = () => h.page.evaluate(() => {
    const w = (sel: string) => +getComputedStyle(document.querySelector(sel)!).fontWeight;
    return { note: w('.card[data-id="n1"] .nbody p'), bold: w('.card[data-id="n1"] .nbody strong'), text: w('.card[data-id="t1"] .tx p') };
  });
  const h = await open({ board: b, light: true, w: 800, h: 480, settings: { theme: "soft-light" } as never });
  await idle(h);
  const soft = await weights();
  await h.page.screenshot({ path: path.join(OUT, "soft-light-note-weight.png"), clip: { x: 30, y: 30, width: 620, height: 360 } });
  await h.page.context().close();
  const h2 = await open({ board: b, light: true, w: 800, h: 480, settings: { theme: "warm-ink" } as never });
  await idle(h2);
  const warm = await h2.page.evaluate(() => +getComputedStyle(document.querySelector('.card[data-id="n1"] .nbody p')!).fontWeight);
  await h2.page.screenshot({ path: path.join(OUT, "warm-ink-note-weight.png"), clip: { x: 30, y: 30, width: 620, height: 360 } });
  await h2.page.context().close();
  check("softLightNoteBodyWeight", soft.note === 400 && soft.bold >= 600 && soft.text === 400 && warm === 400, { soft, warm });
});

/** Drafting: a Text card's body is in the same font as a Note's body (DM Mono at the same size, with the same CJK fallback), not
 *  a bigger one with another fallback */
test("draftingTextMatchesNoteFont", async () => {
  const b = emptyBoard("b1", "drafting fonts");
  b.cards.push({ id: "n1", kind: "note", look: "note", md: "draft 模式下的高亮换一个色，现在太不搭调了" } as any);
  b.place.n1 = { x: 60, y: 40, w: 381 };
  b.cards.push({ id: "t1", kind: "note", look: "text", size: "body", md: "draft 模式的 text 的字体和 note 完全不一样" } as any);
  b.place.t1 = { x: 60, y: 220, w: 381 };
  b.cam = { x: 0, y: 0, z: 1 };
  const h = await open({ board: b, light: true, w: 560, h: 340, settings: { theme: "drafting" } as never });
  await idle(h);
  const f = await h.page.evaluate(() => {
    const cs = (sel: string) => { const s = getComputedStyle(document.querySelector(sel)!); return { family: s.fontFamily, size: s.fontSize, spacing: s.letterSpacing, weight: s.fontWeight, color: s.color }; };
    return { note: cs('.card[data-id="n1"] .nbody p'), text: cs('.card[data-id="t1"] .tx p') };
  });
  await h.page.screenshot({ path: path.join(OUT, "drafting-text-font.png") });
  check("draftingTextMatchesNoteFont", f.note.family === f.text.family && f.note.size === f.text.size, f);
});

/** Drafting: a selected card is marked by its dark outline and the dashed frame around it, with no "SELECTED" label above it */
test("draftingSelectedCardHasNoLabel", async () => {
  const b = emptyBoard("b1", "drafting selection");
  b.cards.push({ id: "n1", kind: "note", look: "note", md: "A selected note" } as any);
  b.place.n1 = { x: 60, y: 90, w: 381 };
  b.cam = { x: 0, y: 0, z: 1 };
  const h = await open({ board: b, light: true, w: 560, h: 300, settings: { theme: "drafting" } as never });
  await idle(h);
  await h.page.locator('.card[data-id="n1"] .chead').click();
  await h.page.locator('.card[data-id="n1"].sel').waitFor();
  await idle(h);
  const pseudo = await h.page.evaluate(() => {
    const c = document.querySelector('.card[data-id="n1"]')!;
    return { before: getComputedStyle(c, "::before").content, after: getComputedStyle(c, "::after").content };
  });
  await h.page.screenshot({ path: path.join(OUT, "drafting-selected.png") });
  check("draftingSelectedCardHasNoLabel", !/SELECTED/.test(pseudo.before) && pseudo.after !== "none", pseudo);
});

/** Drafting (light and dark): ==highlight== has no highlighter fill, only an ink underline, in the static Note and in its editor;
 *  Warm Ink keeps its highlighter band */
test("draftingHighlightUnderline", async () => {
  const b = emptyBoard("b1", "drafting highlight");
  b.cards.push({ id: "n1", kind: "note", look: "note", md: "draft 模式下的 ==高亮换一个色== and ==a **bold** phrase==" } as any);
  b.place.n1 = { x: 60, y: 90, w: 381 };
  b.cam = { x: 0, y: 0, z: 1 };
  const look = (pg: Awaited<ReturnType<typeof open>>["page"], sel: string) => pg.evaluate((sel) => [...document.querySelectorAll(sel)].map((m) => {
    const s = getComputedStyle(m);
    return { bg: s.backgroundImage, bgc: s.backgroundColor, line: s.textDecorationLine, thick: s.textDecorationThickness, offset: s.textUnderlineOffset, color: s.textDecorationColor, ink: getComputedStyle(document.documentElement).getPropertyValue("--ink").trim() };
  }), sel);
  const res: Record<string, unknown> = {};
  let ok = true;
  // the editor draws a highlight as decorations, split into several <mark>s where other formatting or hidden markers cut it
  const plain = (l: Awaited<ReturnType<typeof look>>, edit = false) => (edit ? l.length >= 2 : l.length === 2) && l.every((m) => m.bg === "none" && /rgba\(0, 0, 0, 0\)|transparent/.test(m.bgc) && m.line === "underline" && m.thick === "1.5px" && m.offset === "3px");
  for (const lt of [true, false]) {
    const h = await open({ board: b, light: lt, w: 560, h: 260, settings: { theme: "drafting" } as never });
    await idle(h);
    const shown = await look(h.page, '.card[data-id="n1"] .nbody mark');
    await h.page.screenshot({ path: path.join(OUT, `drafting-highlight-${lt ? "light" : "dark"}.png`) });
    await h.page.locator('.card[data-id="n1"] .nbody p').dblclick();
    await h.page.locator('.card[data-id="n1"] .md-pm mark').first().waitFor();
    await idle(h);
    const edit = await look(h.page, '.card[data-id="n1"] .md-pm mark');
    res[lt ? "light" : "dark"] = { shown, edit };
    ok &&= plain(shown) && plain(edit, true);
    await h.page.context().close();
  }
  const h = await open({ board: b, light: true, w: 560, h: 260, settings: { theme: "warm-ink" } as never });
  await idle(h);
  const warm = await look(h.page, '.card[data-id="n1"] .nbody mark');
  await h.page.context().close();
  res.warm = warm;
  check("draftingHighlightUnderline", ok && warm.length === 2 && warm.every((m) => m.bg.startsWith("linear-gradient(") && m.line === "none"), res);
});

/** Drafting (usage feedback #57): bold in a Note's body only gets heavier, in the body's font (DM Mono) and spacing, in the static
 *  Note and in its editor; headings keep the heading font */
test("draftingBoldKeepsBodyFont", async () => {
  const b = emptyBoard("b1", "drafting bold");
  b.cards.push({ id: "n1", kind: "note", look: "note", md: "用 **for 循环** 遍历每个 thread block，<b>bold</b> 也一样。\n\n## 循环展开\n\n每次处理 4 个元素。" } as any);
  b.place.n1 = { x: 60, y: 40, w: 381 };
  b.cam = { x: 0, y: 0, z: 1 };
  const h = await open({ board: b, light: true, w: 560, h: 280, settings: { theme: "drafting" } as never });
  await idle(h);
  const fonts = (root: string) => h.page.evaluate((root) => {
    const cs = (sel: string) => [...document.querySelectorAll(`${root} ${sel}`)].map((e) => { const s = getComputedStyle(e); return { family: s.fontFamily, spacing: s.letterSpacing, weight: +s.fontWeight }; });
    return { p: cs("p")[0], bold: [...cs("strong"), ...cs("b")], h2: cs("h2")[0] };
  }, root);
  const ok = (f: Awaited<ReturnType<typeof fonts>>) => !!f.p && !!f.h2 && f.bold.length > 0 && f.h2.family !== f.p.family &&
    f.bold.every((s) => s.family === f.p.family && s.spacing === f.p.spacing && s.weight > f.p.weight);
  const shown = await fonts('.card[data-id="n1"] .nbody');
  await h.page.screenshot({ path: path.join(OUT, "drafting-bold-font.png") });
  await h.page.locator('.card[data-id="n1"] .nbody p').first().dblclick();
  await h.page.locator('.card[data-id="n1"] .md-pm strong').first().waitFor();
  await idle(h);
  const edit = await fonts('.card[data-id="n1"] .md-pm');
  check("draftingBoldKeepsBodyFont", ok(shown) && ok(edit), { shown, edit });
});

/** Ink Wash: bold is 700 (Source Serif here stops at 600) with a .015em text stroke: .025em was too heavy, none too light on a Mac; the same while editing */
test("inkWashBoldStandsOut", async () => {
  const b = emptyBoard("b1", "ink wash bold");
  b.cards.push({ id: "n1", kind: "note", look: "note", md: "程序员可以指定**变量的可见范围和访问速度**，<b>bold</b> 也一样。" } as any);
  b.place.n1 = { x: 60, y: 40, w: 381 };
  b.cam = { x: 0, y: 0, z: 1 };
  const h = await open({ board: b, light: true, w: 560, h: 220, settings: { theme: "ink-wash" } as never });
  await idle(h);
  const bold = (root: string) => h.page.evaluate((root) => [...document.querySelectorAll(`${root} :is(strong, b)`)].map((e) => {
    const s = getComputedStyle(e), p = getComputedStyle(e.closest("p")!);
    return { weight: +s.fontWeight, stroke: parseFloat((s as any).webkitTextStrokeWidth) || 0, size: parseFloat(s.fontSize), body: +p.fontWeight };
  }), root);
  const ok = (r: Awaited<ReturnType<typeof bold>>) => r.length === 2 && r.every((x) => x.weight === 700 && Math.abs(x.stroke - .015 * x.size) < .01 && x.body <= 400);
  const shown = await bold('.card[data-id="n1"] .nbody');
  await shot(h, "ink-wash-bold");
  await h.page.locator('.card[data-id="n1"] .nbody p').first().dblclick();
  await h.page.locator('.card[data-id="n1"] .md-pm strong').first().waitFor();
  await idle(h);
  const edit = await bold('.card[data-id="n1"] .md-pm');
  check("inkWashBoldStandsOut", ok(shown) && ok(edit), { shown, edit });
});

/** Ink Wash (usage feedback #85): ==highlight== is a vermilion brush stroke under the words instead of the yellow marker, light and dark,
 *  static and while editing, each wrapped line with its own stroke; other themes keep the marker */
test("inkWashHighlightBrush", async () => {
  const b = emptyBoard("b1", "ink wash highlight");
  b.cards.push({ id: "n1", kind: "note", look: "note", md: "性能取决于==核心执行这些指令的速度==，即 ==FLOP/B==。我们把这个比值称为==算术强度（arithmetic intensity）或计算强度（computational intensity）==。" } as any);
  b.place.n1 = { x: 60, y: 90, w: 381 };
  b.cam = { x: 0, y: 0, z: 1 };
  const look = (pg: Awaited<ReturnType<typeof open>>["page"], sel: string) => pg.evaluate((sel) => [...document.querySelectorAll(sel)].map((m) => {
    const s = getComputedStyle(m);
    return { bg: s.backgroundImage.slice(0, 40), size: s.backgroundSize, clone: s.boxDecorationBreak || (s as any).webkitBoxDecorationBreak, lines: m.getClientRects().length };
  }), sel);
  const brush = (l: Awaited<ReturnType<typeof look>>) => l.length === 3 && l.every((m) => m.bg.startsWith('url("data:image/svg+xml') && m.clone === "clone") && l.some((m) => m.lines > 1);
  const res: Record<string, unknown> = {};
  let ok = true;
  for (const lt of [true, false]) {
    const h = await open({ board: b, light: lt, w: 560, h: 280, settings: { theme: "ink-wash" } as never });
    await idle(h);
    const shown = await look(h.page, '.card[data-id="n1"] .nbody mark');
    await shot(h, `ink-wash-highlight-${lt ? "light" : "dark"}`);
    await h.page.locator('.card[data-id="n1"] .nbody p').dblclick();
    await h.page.locator('.card[data-id="n1"] .md-pm mark').first().waitFor();
    await idle(h);
    const edit = await look(h.page, '.card[data-id="n1"] .md-pm mark');
    res[lt ? "light" : "dark"] = { shown, edit };
    ok &&= brush(shown) && brush(edit);
    await h.page.context().close();
  }
  const h = await open({ board: b, light: true, w: 560, h: 280, settings: { theme: "warm-ink" } as never });
  await idle(h);
  const warm = await look(h.page, '.card[data-id="n1"] .nbody mark');
  await h.page.context().close();
  res.warm = warm;
  check("inkWashHighlightBrush", ok && warm.length === 3 && warm.every((m) => m.bg.startsWith("linear-gradient(")), res);
});
