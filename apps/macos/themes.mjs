// The board's colour tokens for the native app, read from its stylesheets (packages/board/src/styles.css, themes.css) at build time:
// every look, light and dark, each token resolved (var(), color-mix) to one colour `#rrggbbaa`, numbers (--r-card: 12.5px) as
// numbers. build.mjs writes it to dist/themes.json; Theme.swift reads it, so the app never copies a hex value by hand.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const BOARD = join(here, "../../packages/board/src");

/** The declarations of a rule body: split at `;` outside parentheses and quotes (a data: URL has one inside) */
function declarations(body) {
  const out = [];
  let depth = 0,
    quote = "",
    cur = "";
  for (const ch of body) {
    if (quote) {
      if (ch === quote) quote = "";
    } else if (ch === '"' || ch === "'") quote = ch;
    else if (ch === "(") depth++;
    else if (ch === ")") depth--;
    if (ch === ";" && depth === 0 && !quote) {
      out.push(cur);
      cur = "";
    } else cur += ch;
  }
  out.push(cur);
  const decls = {},
    props = {};
  for (const d of out) {
    const m = /^\s*(--)?([\w-]+)\s*:\s*([\s\S]+?)\s*$/.exec(d);
    if (!m) continue;
    (m[1] ? decls : props)[m[2]] = m[3].replace(/\s+/g, " ").trim();
  }
  return { decls, props };
}

/** Every rule's selectors and its declarations, at any nesting depth; media: inside an @media block (a reduced-motion or print
 *  variant the app does not draw) */
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
      stack.push({ sel, body: "", media: stack.some((r) => r.sel.startsWith("@media")) });
      i = open + 1;
    } else {
      const r = stack.pop();
      if (r) {
        r.body += css.slice(i, close);
        out.push({ sels: r.sel.split(",").map((s) => s.trim()), media: r.media, ...declarations(r.body) });
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
      (_, n, fb) => get(n, new Set(seen)) || fb?.trim() || "",
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

/** Top-level comma-separated parts of a value (commas inside parentheses stay) */
function parts(v) {
  const out = [];
  let depth = 0,
    cur = "";
  for (const ch of v) {
    if (ch === "(") depth++;
    if (ch === ")") depth--;
    if (ch === "," && depth === 0) {
      out.push(cur.trim());
      cur = "";
    } else cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}
/** A box-shadow list → [{x, y, blur, spread, color, inset}] (px), or null */
function shadows(v) {
  if (v === "none") return [];
  const out = [];
  for (const p of parts(v)) {
    const inset = /\binset\b/.test(p);
    const col = /color-mix\((?:[^()]|\([^()]*\))*\)|rgba?\([^)]*\)|#[0-9a-f]{3,8}\b|\btransparent\b/i.exec(p);
    if (!col) return null;
    const nums = p
      .replace(col[0], "")
      .replace("inset", "")
      .trim()
      .split(/\s+/)
      .map((n) => Number.parseFloat(n));
    if (nums.length < 2 || nums.some(Number.isNaN)) return null;
    const c = color(col[0]);
    if (!c) return null;
    out.push({ x: nums[0], y: nums[1], blur: nums[2] ?? 0, spread: nums[3] ?? 0, color: hex(c), inset });
  }
  return out;
}
/** linear-gradient(<angle>deg, <color> <pos>, …) → {angle, stops: [{color, at}]} (at in 0–1), or null */
function gradient(v) {
  const m = /^linear-gradient\(\s*(-?[\d.]+)deg\s*,\s*(.*)\)$/s.exec(v);
  if (!m) return null;
  const stops = [];
  for (const p of parts(m[2])) {
    const pm = /^(.*?)\s+(-?[\d.]+)(%|px)?$/s.exec(p);
    const c = color(pm ? pm[1] : p);
    if (!c) return null;
    stops.push({ color: hex(c), at: pm ? Number(pm[2]) / (pm[3] === "%" ? 100 : 1) : stops.length ? 1 : 0 });
  }
  return { angle: Number(m[1]), stops };
}
/** calc(<a>px + <b>px) and the like: the few forms the picks use */
function calc(v) {
  return v
    .replace(
      /calc\(\s*(-?[\d.]+)px\s*([+-])\s*(-?[\d.]+)px\s*\)/g,
      (_, a, op, b) => `${op === "+" ? Number(a) + Number(b) : Number(a) - Number(b)}px`,
    )
    .replace(/calc\(\s*(-?[\d.]+)px\s*\*\s*(-?[\d.]+)\s*\)/g, (_, a, k) => `${Number(a) * Number(k)}px`)
    .replace(/min\(\s*(-?[\d.]+)px\s*,\s*(-?[\d.]+)px\s*\)/g, (_, a, b) => `${Math.min(Number(a), Number(b))}px`);
}
/** A border shorthand (<width> <style> <color>, e.g. --sect-border: 0.5px solid var(--hair)) → {w, style, color}, or null */
function border(v) {
  const m = /^(-?[\d.]+)px\s+(solid|dashed|dotted)\s+(.+)$/s.exec(v);
  if (!m) return null;
  const c = color(m[3]);
  return c ? { w: Number(m[1]), style: m[2], color: hex(c) } : null;
}
/** A translate (themes.css .secho translate: 5px 5px) → {x, y}, or null */
function translate(v) {
  const m = /^(-?[\d.]+)px(?:\s+(-?[\d.]+)px)?$/.exec(v);
  return m ? { x: Number(m[1]), y: Number(m[2] ?? m[1]) } : null;
}
/** The token's value for the app: a colour (a shadow list: its last colour), a number, a shadow list, a gradient or a border, or
 *  nothing */
function value(v) {
  v = calc(v);
  const c = color(v);
  if (c) return hex(c);
  const n = /^(-?[\d.]+)(px|deg)?$/.exec(v);
  if (n) return Number(n[1]);
  return shadows(v) ?? gradient(v) ?? border(v) ?? translate(v) ?? undefined;
}

/**
 * Plain declarations the app draws from, beside the tokens: the rule's selector in the look's light and dark stylesheets and
 * the property, under a name of the app's. Values go through the look's tokens (var()) and `value` like a token
 */
const PICKS = {
  "ink-wash": [
    [
      "card-shadow",
      ":root.look-ink-wash .card:not(.text):not(.nobg)",
      ':root.look-ink-wash[data-theme="dark"] .card:not(.text):not(.nobg)',
      "box-shadow",
    ],
    [
      "card-sel-shadow",
      ":root.look-ink-wash .card.sel:not(.text):not(.nobg)",
      ':root.look-ink-wash[data-theme="dark"] .card.sel:not(.text):not(.nobg)',
      "box-shadow",
    ],
    ["head-bg", ":root.look-ink-wash .card:not(.nobg) > .cface > .chead", null, "background"],
    ["head-pl", ":root.look-ink-wash .card:not(.nobg) > .cface > .chead", null, "padding", (v) => v.split(" ")[3]],
    ["stamp-size", ":root.look-ink-wash .card:not(.text) > .cface::before", null, "width"],
    ["stamp-top", ":root.look-ink-wash .card:not(.text) > .cface::before", null, "top"],
    ["stamp-right", ":root.look-ink-wash .card:not(.text) > .cface::before", null, "right"],
    ["stamp-bg", ":root.look-ink-wash .card:not(.text) > .cface::before", null, "background"],
    ["stamp-ring", ":root.look-ink-wash .card:not(.text) > .cface::before", null, "box-shadow"],
    ["stamp-rotate", ":root.look-ink-wash .card.sel:not(.text) > .cface::before", null, "rotate"],
    ["stamp-opacity", ":root.look-ink-wash .card.sel:not(.text) > .cface::before", null, "opacity"],
    ["sel-lift", ":root.look-ink-wash .card.sel:not(.text):not(.nobg)", null, "translate", (v) => v.split(" ")[1]],
    ["step-ring", ":root.look-ink-wash .chead > .step", null, "box-shadow"],
    ["sbrush-opacity", ":root.look-ink-wash :is(.sbrush, .secho)", null, "fill-opacity"],
    // selected: the strokes' vermilion opacity, the second stroke (its offset and opacity) and the wash (themes.css .sect.sel)
    ["sbrush-sel-opacity", ":root.look-ink-wash .sect.sel .sbrush", null, "fill-opacity"],
    ["secho-offset", ":root.look-ink-wash .secho", null, "translate"],
    ["secho-opacity", ":root.look-ink-wash .sect.sel .secho", null, "opacity"],
    [
      "sect-wash",
      ":root.look-ink-wash .sect::after",
      ':root.look-ink-wash[data-theme="dark"] .sect::after',
      "background",
    ],
    ["slabel-ml", ":root.look-ink-wash .slabel", null, "--ml"],
    ["slabel-mt", ":root.look-ink-wash .slabel", null, "--mt"],
    ["slabel-shut-ml", ":root.look-ink-wash .slabel.collapsed", null, "--ml"],
    ["slabel-shut-mt", ":root.look-ink-wash .slabel.collapsed", null, "--mt"],
    ["brush-opacity", ":root.look-ink-wash .brush", null, "fill-opacity"],
    ["head-dot-opacity", ":root.look-ink-wash .ahead.dot", null, "opacity"],
    ["sum-hd", ':root.look-ink-wash:not([data-theme="dark"]) .sumlay', null, "--sum-hd"],
    ["sum-grey", ':root.look-ink-wash:not([data-theme="dark"]) .sumlay', null, "--sum-grey"],
    ["sum-panel", ':root.look-ink-wash:not([data-theme="dark"]) .sumlay', null, "--sum-panel"],
  ],
  "*": [
    ["card-sel-ring", ".card.sel", null, "--ring"],
    ["board-sel-ring", ".card.board.sel", null, "--ring"],
    ["board-radius", ".card.board", null, "--cr"],
    ["band", ".hx-band", ':root[data-theme="dark"] .hx-band', "--band"],
    ["no-opacity", ".no", null, "opacity", (v) => v.replace(/^var\(--no-o,\s*([\d.]+)\)$/, "$1")],
    ["slabel-ml", ".slabel", null, "--ml"],
    ["slabel-mt", ".slabel", null, "--mt"],
    ["slabel-shut-ml", ".slabel", null, "--ml"],
    ["slabel-shut-mt", ".slabel", null, "--mt"],
    ["sect-radius", ".sect", null, "border-radius"],
    // a collapsed Section's corners (styles.css .sect.shut: min(r-card + 1, 10))
    ["sect-shut-radius", ".sect.shut", null, "border-radius"],
    // selected: the ring outside the border and the wash over the fill (styles.css .sect.sel, .sect::after)
    [
      "sect-sel-ring",
      ".sect.sel",
      null,
      "box-shadow",
      (v) =>
        parts(v)
          .filter((p) => !/\binset\b/.test(p) && !p.startsWith("var("))
          .join(", "),
    ],
    ["sect-wash", ".sect::after", null, "background"],
    ["card-soft-shadow", ".card::before", null, "box-shadow"],
    // the summary level's type (styles.css .sumlay; the looks override under :root.look-*)
    ["sum-hd", ".sumlay", ':root[data-theme="dark"] .sumlay', "--sum-hd"],
    ["sum-grey", ".sumlay", ':root[data-theme="dark"] .sumlay', "--sum-grey"],
    ["sum-panel", ".sumlay", ':root[data-theme="dark"] .sumlay', "--sum-panel"],
  ],
  "warm-ink": [
    // the arrows' colour is set on the links layer, not the root (themes.css .lyr --edge: var(--wi-edge))
    ["edge", ":root.look-warm-ink .lyr", null, "--edge"],
    ["sum-hd", ':root.look-warm-ink:not([data-theme="dark"]) .sumlay', null, "--sum-hd"],
    ["sum-grey", ':root.look-warm-ink:not([data-theme="dark"]) .sumlay', null, "--sum-grey"],
  ],
};
const propOf = (rs, sel, prop) => {
  let v;
  for (const r of rs)
    if (
      !r.media &&
      r.sels.includes(sel) &&
      (prop.startsWith("--") ? r.decls[prop.slice(2)] : r.props[prop]) !== undefined
    )
      v = prop.startsWith("--") ? r.decls[prop.slice(2)] : r.props[prop];
  return v;
};

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
    // a look's tokens are declared for the whole page (:root.look-x) or a board inside one ([data-look="x"]): both
    const own = { ...tokensOf(rs, `[data-look="${look}"]`), ...tokensOf(rs, `:root.look-${look}`) },
      ownDark = {
        ...tokensOf(rs, `:root[data-theme="dark"] [data-look="${look}"]`),
        ...tokensOf(rs, `:root.look-${look}[data-theme="dark"]`),
      };
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
      return [o, map];
    };
    const [light, lightMap] = pick({ ...base, ...own }),
      [dark, darkMap] = pick({ ...base, ...baseDark, ...own, ...ownDark });
    for (const [name, selLight, selDark, prop, fix] of [...PICKS["*"], ...(PICKS[look] ?? [])]) {
      const take = (sel, map) => {
        if (!sel) return undefined;
        let v = propOf(rs, sel, prop);
        if (v === undefined) return undefined;
        if (fix) v = fix(v);
        return value(resolveVars({ ...map, [name]: v })[name]);
      };
      const l = take(selLight, lightMap),
        d = take(selDark, darkMap) ?? take(selLight, darkMap);
      if (l !== undefined) light[name] = l;
      if (d !== undefined) dark[name] = d;
      else if (l !== undefined) dark[name] = l;
    }
    out[look] = { light, dark };
  }
  return out;
}

/** Ink Wash's two seal-mask images (themes.css --seal-mask: the grain tile and the rough edge), as PNG bytes */
export function sealMasks(root = BOARD) {
  const rs = rules(readFileSync(join(root, "themes.css"), "utf8"));
  const v = tokensOf(rs, ":root.look-ink-wash")["seal-mask"] ?? "";
  return [...v.matchAll(/url\("data:image\/png;base64,([^"]+)"\)/g)].map((m) => Buffer.from(m[1], "base64"));
}

/** The board's icons (packages/board/src/ui/icons.tsx): name → {stroke, fill} path data on a 16 grid */
export function icons(root = BOARD) {
  const src = readFileSync(join(root, "ui/icons.tsx"), "utf8");
  const table = (name) => {
    const m = new RegExp(`const ${name}: Record<string, string> = \\{([\\s\\S]*?)\\n\\};`).exec(src);
    const out = {};
    for (const e of (m?.[1] ?? "").matchAll(/^\s*(\w+):\s*"([^"]+)"/gm)) out[e[1]] = e[2];
    return out;
  };
  const P = table("P"),
    F = table("F"),
    out = {};
  for (const k of new Set([...Object.keys(P), ...Object.keys(F)])) out[k] = { stroke: P[k], fill: F[k] };
  return out;
}
