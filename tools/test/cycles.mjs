// Circular imports inside each package (packages/*/src, extensions/vscode/src): the runtime import graph (type-only imports and
// lazy import() calls left out, as neither runs a module before the other is done), its strongly connected components
import * as fs from "node:fs";
import * as path from "node:path";

const EXTS = [".ts", ".tsx", "/index.ts", "/index.tsx"];
// import / export … from "./x", side-effect import "./x"; `import type` / `export type` are left out
const STATIC = /(?:^|\n)\s*(?:import|export)\s+(?!type\s)(?:([^"'`;]*?)\sfrom\s*)?["'](\.{1,2}\/[^"']+)["']/g;
/** `{ type A, type B as C }` alone: type-only too */
const typesOnly = (clause) => {
  const m = /^\{([^}]*)\}$/.exec(clause.trim());
  return (
    !!m &&
    m[1]
      .split(",")
      .map((x) => x.trim())
      .filter(Boolean)
      .every((x) => x.startsWith("type "))
  );
};

function files(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...files(p));
    else if (/\.tsx?$/.test(e.name) && !e.name.endsWith(".d.ts")) out.push(p);
  }
  return out;
}

function resolve(from, spec) {
  const base = path.resolve(path.dirname(from), spec.replace(/\.(m?js|tsx?)$/, ""));
  for (const x of ["", ...EXTS]) {
    const p = base + x;
    if (/\.tsx?$/.test(p) && fs.existsSync(p) && fs.statSync(p).isFile()) return p;
  }
  return null;
}

/** Each cycle as the sorted list of its files (relative to repo) */
export function cycles(repo, srcDir) {
  const all = files(path.resolve(repo, srcDir));
  const edges = new Map(all.map((f) => [f, new Set()]));
  for (const f of all) {
    const text = fs.readFileSync(f, "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
    for (const m of text.matchAll(STATIC)) {
      if (m[1] && typesOnly(m[1])) continue;
      const to = resolve(f, m[2]);
      if (to && edges.has(to)) edges.get(f).add(to);
    }
  }
  // Tarjan's strongly connected components
  let n = 0;
  const idx = new Map(),
    low = new Map(),
    on = new Set(),
    st = [],
    out = [];
  const visit = (v) => {
    idx.set(v, n);
    low.set(v, n);
    n++;
    st.push(v);
    on.add(v);
    for (const w of edges.get(v)) {
      if (!idx.has(w)) {
        visit(w);
        low.set(v, Math.min(low.get(v), low.get(w)));
      } else if (on.has(w)) low.set(v, Math.min(low.get(v), idx.get(w)));
    }
    if (low.get(v) === idx.get(v)) {
      const c = [];
      let w;
      do {
        w = st.pop();
        on.delete(w);
        c.push(w);
      } while (w !== v);
      if (c.length > 1 || edges.get(v).has(v)) out.push(c.map((f) => path.relative(repo, f)).sort());
    }
  };
  for (const f of all) if (!idx.has(f)) visit(f);
  return out.sort((a, b) => a[0].localeCompare(b[0]));
}
