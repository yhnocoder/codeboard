// v0.1.7 looks (Ink Wash, City): node run-harness.mjs themeLooks [--light]; City roads, cars and traffic: cityTheme
import * as fs from "node:fs";
import { open, shot, symCard, findSym, put } from "./harness";
import { emptyBoard, type Board } from "@codeboard/core";

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

export const THEMES: Record<string, () => Promise<void>> = {
  /** City: every arrow end is a parked car (merged ends: one car per junction) waiting at a zebra crossing, main roads have a shoulder,
   *  white edge lines and a double yellow centre line, small streets a white centre line,
   *  traffic off = no animation at all; on = cars driving (transform / opacity only, compositor); reduced motion = off. Screenshots to SHOTS */
  async cityTheme() {
    const SHOTS = process.env.CITY_SHOTS ?? "/mnt/project-files/v017/themes";
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
      await shot(h, `v17-city-${light ? "light" : "dark"}-off`);
      try { await h.page.screenshot({ path: `${SHOTS}/city-${light ? "light" : "dark"}-off.png` }); } catch { /* ignore */ }
      await h.page.locator(".dock .traffic").click(); await h.page.mouse.move(5, 500); await h.page.waitForTimeout(1500);
      const on = await probe();
      await shot(h, `v17-city-${light ? "light" : "dark"}-on`);
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
      console.log(ok ? "PASS" : "FAIL", "cityTheme", light ? "light" : "dark", JSON.stringify({ off, on: { movers: on.movers, running: on.running, compOnly: on.compOnly }, back: back.running, reduced: reduced.running }));
      await h.page.context().browser()!.close();
      // Close-up of the junction and the parked cars (road markings, zebra crossings): screenshot only
      b.cam = { x: -1050, y: -1200, z: 2.5 };
      const z = await open({ board: b, light, w: 1300, h: 900, settings: { theme: "city" } as any });
      await z.page.waitForTimeout(800);
      await shot(z, `v17-city-${light ? "light" : "dark"}-zoom`);
      try { await z.page.screenshot({ path: `${SHOTS}/city-${light ? "light" : "dark"}-zoom.png` }); } catch { /* ignore */ }
      await z.page.context().browser()!.close();
    }
  },
  /** Each new look in light and dark: per-file hue on code cards, icon stroke 1 or 2 px, scene backgrounds,
   *  the City traffic light (only in City, red by default), and no endless animation running */
  async themeLooks() {
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
      await shot(h, `v17-look-${theme}-${light ? "light" : "dark"}`);
      const ok = r.look === theme
        && r.stroke === STROKE[theme] && r.endless === 0 && (theme === "city" ? endlessOn > 0 : endlessOn === 0)
        && (theme === "ink-wash" || theme === "city" ? r.scene : true)
        && (theme === "city" ? r.traffic === 1 && r.pressed === "false" && toggled === "true" : r.traffic === 0);
      console.log(ok ? "PASS" : "FAIL", "theme-look", theme, light ? "light" : "dark", JSON.stringify(r), toggled ?? "");
      await h.page.context().browser()!.close();
    }
  },
};
