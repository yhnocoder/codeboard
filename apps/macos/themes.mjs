// The board's colour tokens for the native app, read from its stylesheets (packages/board/src/styles.css, themes.css) at build time:
// every look, light and dark, each token resolved (var(), color-mix) to one colour `#rrggbbaa`, numbers (--r-card: 12.5px) as
// numbers. build.mjs writes it to dist/themes.json; Theme.swift reads it, so the app never copies a hex value by hand.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const BOARD = join(here, "../../packages/board/src");

/** Every rule's selectors and its custom-property declarations, at any nesting depth */
function rules(css) {
  const out = [];
  let i = 0;
  const stack = [];
  css = css.replace(/\/\*[\s\S]*?\*\//g, "");
  while (i < css.length) {
    const open = css.indexOf("{", i);
    const close = css.indexOf("}", i);
    if (open === -1 && close === -1) break;
    if (open !== -1 && open < close) {
      const sel = css.slice(i, open).trim();
      stack.push({ sel, body: "" });
      i = open + 1;
    } else {
      const r = stack.pop();
      if (r) {
        r.body += css.slice(i, close);
        const decls = {};
        for (const m of r.body.matchAll(/--([\w-]+)\s*:\s*([^;]+);/g)) decls[m[1]] = m[2].replace(/\s+/g, " ").trim();
        out.push({ sels: r.sel.split(",").map((s) => s.trim()), decls });
      }
      i = close + 1;
    }
  }
  return out;
}

const tokensOf = (rs, sel) => Object.assign({}, ...rs.filter((r) => r.sels.includes(sel)).map((r) => r.decls));

function resolveVars(map) {
  const out = {};
  const get = (k, seen = new Set()) => {
    if (seen.has(k)) return "";
    seen.add(k);
    const v = map[k];
    if (v === undefined) return "";
    return v.replace(
      /var\(--([\w-]+)(?:,\s*([^()]*(?:\([^()]*\))?[^()]*))?\)/g,
      (_, n, fb) => get(n, seen) || fb?.trim() || "",
    );
  };
  for (const k of Object.keys(map)) out[k] = get(k);
  return out;
}

const clamp = (x) => Math.max(0, Math.min(255, Math.round(x)));
const hex = ([r, g, b, a]) =>
  `#${[clamp(r), clamp(g), clamp(b), clamp(a * 255)].map((n) => n.toString(16).padStart(2, "0")).join("")}`;

/** A colour value → [r, g, b, a], or null */
function color(v) {
  v = v.trim();
  if (v === "transparent") return [0, 0, 0, 0];
  if (v === "white") return [255, 255, 255, 1];
  if (v === "black") return [0, 0, 0, 1];
  let m = /^#([0-9a-f]{3,8})$/i.exec(v);
  if (m) {
    let h = m[1];
    if (h.length <= 4) h = [...h].map((c) => c + c).join("");
    const n = Number.parseInt(h.padEnd(8, "f"), 16);
    return [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, (n & 255) / 255];
  }
  m = /^rgba?\(([^)]*)\)$/.exec(v);
  if (m) {
    const parts = m[1]
      .split(/[\s,/]+/)
      .filter(Boolean)
      .map(Number);
    if (parts.length < 3 || parts.some(Number.isNaN)) return null;
    return [parts[0], parts[1], parts[2], parts[3] ?? 1];
  }
  m = /^color-mix\(in srgb,\s*(.+?)\s+([\d.]+)%\s*,\s*(.+)\)$/.exec(v);
  if (m) {
    const a = color(m[1]),
      b = color(m[3]),
      p = Number(m[2]) / 100;
    if (!a || !b) return null;
    // premultiplied mix, as CSS does: a transparent partner only thins the colour
    const aa = a[3] * p + b[3] * (1 - p);
    if (!aa) return [0, 0, 0, 0];
    const ch = (i) => (a[i] * a[3] * p + b[i] * b[3] * (1 - p)) / aa;
    return [ch(0), ch(1), ch(2), aa];
  }
  return null;
}

/** The token's value for the app: a colour (a shadow list: its last colour), a number, or nothing */
function value(v) {
  const c = color(v);
  if (c) return hex(c);
  const n = /^(-?[\d.]+)(px)?$/.exec(v);
  if (n) return Number(n[1]);
  const all = [...v.matchAll(/#[0-9a-f]{3,8}\b|rgba?\([^)]*\)/gi)].map((m) => color(m[0])).filter(Boolean);
  return all.length ? hex(all[all.length - 1]) : undefined;
}

/** { look: { light: { token: value }, dark: {…} } } for every look in the stylesheets */
export function themes(root = BOARD) {
  const rs = [
    ...rules(readFileSync(join(root, "styles.css"), "utf8")),
    ...rules(readFileSync(join(root, "themes.css"), "utf8")),
  ];
  // the Box fills (--bf-*) are set on the component, from the look's --surface: taken in as base tokens
  const base = { ...tokensOf(rs, ":root"), ...tokensOf(rs, ".card.text.box") },
    baseDark = tokensOf(rs, ':root[data-theme="dark"]');
  const looks = new Set(["warm-ink"]);
  for (const r of rs)
    for (const s of r.sels) {
      const m = /^\[data-look="([\w-]+)"\]$/.exec(s);
      if (m) looks.add(m[1]);
    }
  const out = {};
  for (const look of looks) {
    const own = tokensOf(rs, `[data-look="${look}"]`),
      ownDark = tokensOf(rs, `:root[data-theme="dark"] [data-look="${look}"]`);
    const pick = (map) => {
      // [data-look]:not([data-look="warm-ink"]) resets the Note code colours (--nc-*) unless the look sets them itself
      if (look !== "warm-ink")
        for (const k of Object.keys(map)) if (k.startsWith("nc-") && !(k in own) && !(k in ownDark)) delete map[k];
      const res = resolveVars(map),
        o = {};
      for (const [k, v] of Object.entries(res)) {
        const x = value(v);
        if (x !== undefined) o[k] = x;
      }
      return o;
    };
    out[look] = { light: pick({ ...base, ...own }), dark: pick({ ...base, ...baseDark, ...own, ...ownDark }) };
  }
  return out;
}
