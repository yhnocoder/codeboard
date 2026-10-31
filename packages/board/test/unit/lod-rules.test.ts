// The zoom levels switch a card's own .lo-ov / .lo-map class (state/lodcards.ts, a batch of cards per frame). That stays cheap only
// while a switch restyles the card and the few elements the rules name, not the hundreds of nodes inside the card:
// - a rule under a LOD class names its target by class or tag: with a bare * (".card.lo-map .x > *") Chromium restyles the card's whole subtree
// - a custom property the LOD rules set on the card is registered with inherits: false: an inherited one changes the computed style of every node inside
// Each of these slipped in once and made switching 241 cards to the map level ~4x slower
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SRC = fileURLToPath(new URL("../../src", import.meta.url));
const walk = (dir: string): string[] => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]));
const LOD = /\.lo-(ov|map)\b/;

/** Split at top-level commas / combinators (not inside :is(), :not(), [attr]) */
function splitTop(s: string, at: RegExp): string[] {
  const out: string[] = [];
  let depth = 0, cur = "";
  for (const ch of s) {
    if ("([".includes(ch)) depth++;
    else if (")]".includes(ch)) depth--;
    if (depth === 0 && at.test(ch)) { out.push(cur); cur = ""; continue; }
    cur += ch;
  }
  out.push(cur);
  return out.map((x) => x.trim()).filter(Boolean);
}

/** Every rule: its selectors (one per comma) and its declarations */
function rules(css: string): { sels: string[]; body: string }[] {
  const out: { sels: string[]; body: string }[] = [];
  for (const m of css.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/([^{}]*)\{([^{}]*)\}/g)) {
    const head = m[1].trim();
    if (!head || head.startsWith("@")) continue;
    out.push({ sels: splitTop(head, /,/), body: m[2] });
  }
  return out;
}

/** Selectors under a LOD class whose target (rightmost compound) names no class, id or tag */
function bareTargets(css: string): string[] {
  const bad: string[] = [];
  for (const { sels } of rules(css)) for (const s of sels) {
    const parts = splitTop(s.replace(/\s*([>+~])\s*/g, " "), /\s/);
    if (parts.length < 2 || !parts.slice(0, -1).some((p) => LOD.test(p))) continue;
    const last = parts[parts.length - 1].replace(/::[\w-]+(\([^)]*\))?$/, "");
    // :is(.a, .b) names its classes; :not(.x) / :first-child alone don't
    if (!/^[a-z]/i.test(last) && !/^[.#]/.test(last) && !/^:(is|where)\([^)]*[.#a-z]/i.test(last)) bad.push(s);
  }
  return bad;
}

/** Custom properties that a LOD rule sets on the card itself */
function cardProps(css: string): string[] {
  const out = new Set<string>();
  for (const { sels, body } of rules(css)) {
    if (!sels.some((s) => { const parts = splitTop(s.replace(/\s*([>+~])\s*/g, " "), /\s/); return parts.length === 1 && LOD.test(parts[0]) && /\.card\b/.test(parts[0]); })) continue;
    for (const m of body.matchAll(/(--[\w-]+)\s*:/g)) out.add(m[1]);
  }
  return [...out];
}

const nonInherited = (css: string) => new Set([...css.matchAll(/@property\s+(--[\w-]+)\s*\{[^}]*inherits:\s*false/g)].map((m) => m[1]));

describe("zoom level rules", () => {
  const css = walk(SRC).filter((f) => f.endsWith(".css")).map((f) => fs.readFileSync(f, "utf8")).join("\n");
  it("name their targets under a LOD class by class or tag", () => {
    expect(css).toMatch(/\.lo-map/);
    expect(bareTargets(css)).toEqual([]);
  });
  it("set only non-inherited custom properties on the card", () => {
    const props = cardProps(css), ok = nonInherited(css);
    expect(props.length).toBeGreaterThan(0);
    expect(props.filter((p) => !ok.has(p))).toEqual([]);
  });
  it("the checks catch a bare target and an inherited property", () => {
    expect(bareTargets(".card.lo-map .x > * { a: b } .card.lo-map .x > :is(.y, .z) { a: b } .card.lo-ov > :not(.q) { a: b } .card.lo-map .sbhead > svg { a: b } .card.lo-map::after { a: b }"))
      .toEqual([".card.lo-map .x > *", ".card.lo-ov > :not(.q)"]);
    const c = "@property --a { syntax: \"*\"; inherits: false; } .card.lo-map { --a: 1; --b: 2 } .card.lo-map .x { --c: 3 }";
    expect(cardProps(c)).toEqual(["--a", "--b"]);
    expect(cardProps(c).filter((p) => !nonInherited(c).has(p))).toEqual(["--b"]);
  });
});
