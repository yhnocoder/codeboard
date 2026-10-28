// Small path helpers for the 16 px icon sources (icons.src.mjs).
const f = (v) => { const s = (Math.round(v * 1000) / 1000).toString(); return s.startsWith("0.") ? s.slice(1) : s.startsWith("-0.") ? "-" + s.slice(2) : s; };
const pt = (x, y) => `${f(x)} ${f(y)}`;

/** Polyline / polygon through points [x, y, r?]; r rounds that corner with a circular fillet (any angle). */
export function poly(points, closed = false) {
  const n = points.length, P = points.map(([x, y, r = 0]) => ({ x, y, r }));
  const out = [];
  const corner = (i) => {
    const p = P[i], a = P[(i - 1 + n) % n], b = P[(i + 1) % n];
    if (!p.r || (!closed && (i === 0 || i === n - 1))) return null;
    const ux = p.x - a.x, uy = p.y - a.y, ul = Math.hypot(ux, uy), vx = b.x - p.x, vy = b.y - p.y, vl = Math.hypot(vx, vy);
    const dx1 = ux / ul, dy1 = uy / ul, dx2 = vx / vl, dy2 = vy / vl;
    const turn = Math.acos(Math.max(-1, Math.min(1, dx1 * dx2 + dy1 * dy2))), t = p.r * Math.tan(turn / 2);
    const sweep = dx1 * dy2 - dy1 * dx2 > 0 ? 1 : 0;
    return { s: [p.x - dx1 * t, p.y - dy1 * t], e: [p.x + dx2 * t, p.y + dy2 * t], r: p.r, sweep };
  };
  const C = P.map((_, i) => corner(i));
  const start = C[0] ? C[0].e : [P[0].x, P[0].y];
  out.push(`M${pt(...start)}`);
  const last = closed ? n : n - 1;
  for (let k = 1; k <= last; k++) {
    const i = k % n, c = C[i];
    if (c) out.push(`L${pt(...c.s)}A${f(c.r)} ${f(c.r)} 0 0 ${c.sweep} ${pt(...c.e)}`);
    else out.push(`L${pt(P[i].x, P[i].y)}`);
  }
  if (closed) out.push("Z");
  return tidy(out.join(""));
}
/** Rounded rectangle by its stroke centre lines. */
export const rect = (x0, y0, x1, y1, r = 0) => poly([[x0, y0, r], [x1, y0, r], [x1, y1, r], [x0, y1, r]], true);
export const circle = (cx, cy, r) => `M${pt(cx + r, cy)}A${f(r)} ${f(r)} 0 1 1 ${pt(cx - r, cy)}A${f(r)} ${f(r)} 0 1 1 ${pt(cx + r, cy)}Z`;
export const line = (x0, y0, x1, y1) => `M${pt(x0, y0)}L${pt(x1, y1)}`;
export { f as fmt };

/** Shorten absolute path data (only paths made of M / L / A / Z, as poly() writes them): L along an axis -> H / V, drop the comma-free repeats. */
export function tidy(d) {
  let x = 0, y = 0, sx = 0, sy = 0;
  return d.replace(/([MLAZ])([^MLAZ]*)/g, (m, c, a) => {
    const v = a.trim() ? a.trim().split(/[\s,]+/).map(Number) : [];
    if (c === "M") { [x, y] = v; sx = x; sy = y; return m; }
    if (c === "Z") { x = sx; y = sy; return "z"; }
    if (c === "A") { x = v[5]; y = v[6]; return m; }
    const [nx, ny] = v; let r = m;
    if (nx === x && ny !== y) r = `V${f(ny)}`; else if (ny === y && nx !== x) r = `H${f(nx)}`;
    x = nx; y = ny; return r;
  });
}

/** Scale path data by s and move it by (ox, oy); handles every SVG path command, absolute or relative. */
export function xform(d, s, ox = 0, oy = 0) {
  const t = d.match(/[a-zA-Z]|-?(?:\d+\.?\d*|\.\d+)(?:e-?\d+)?/g) ?? [];
  const N = { M: 2, L: 2, H: 1, V: 1, C: 6, S: 4, Q: 4, T: 2, A: 7, Z: 0 };
  let out = "", i = 0, cmd = "";
  while (i < t.length) {
    if (/[a-zA-Z]/.test(t[i])) { cmd = t[i++]; out += cmd; if (cmd.toUpperCase() === "Z") continue; }
    else out += " ";
    const C = cmd.toUpperCase(), low = cmd !== C, rel = low && !(C === "M" && i === 1), v = t.slice(i, i + N[C]).map(Number); i += N[C];
    const X = (x) => (rel ? x * s : x * s + ox), Y = (y) => (rel ? y * s : y * s + oy);
    let r;
    if (C === "H") r = [X(v[0])];
    else if (C === "V") r = [Y(v[0])];
    else if (C === "A") r = [v[0] * s, v[1] * s, v[2], v[3], v[4], X(v[5]), Y(v[6])];
    else r = v.map((n, k) => (k % 2 ? Y(n) : X(n)));
    out += r.map(f).join(" ");
    if (C === "M") cmd = low ? "l" : "L";
  }
  return out.replace(/ -/g, "-");
}
/** A Lucide path (24 grid) on the 16 grid. */
export const lucide = (d) => xform(d, 2 / 3);
