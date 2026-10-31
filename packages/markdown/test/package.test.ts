// What npm publishes for @yhnocoder/markdown: the tarball (npm pack --dry-run, the files field) holds the built dist/ with its
// declarations and stylesheets and none of src/ or test/, every exports target exists, and the built code imports only the
// packages it declares. Needs the build (npm run build makes it, as npm run check and CI do before the tests)
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

const PKG = path.resolve(__dirname, "..");
const pkg = JSON.parse(fs.readFileSync(path.join(PKG, "package.json"), "utf8"));
const DIST = path.join(PKG, "dist");
/** Every file under dir, relative to PKG */
const walk = (dir: string): string[] =>
  fs
    .readdirSync(dir, { withFileTypes: true })
    .flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : [path.relative(PKG, path.join(dir, e.name))]));
/** Every target of the exports map ("./x" strings, conditions included) */
const targets = (e: unknown): string[] => (typeof e === "string" ? [e] : Object.values(e as object).flatMap(targets));

let packed: string[] = [];
beforeAll(() => {
  if (!fs.existsSync(path.join(DIST, "index.js")))
    throw new Error("packages/markdown/dist is missing: run `npm run build -w @yhnocoder/markdown` first");
  // --ignore-scripts: no prepack build here (the build is already there, and a second one would race whoever else reads dist)
  const out = execFileSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], {
    cwd: PKG,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  packed = JSON.parse(out)[0].files.map((f: { path: string }) => f.path);
}, 30e3);

describe("the published @yhnocoder/markdown package", () => {
  it("is public, ESM, with solid-js as a peer dependency", () => {
    expect(pkg.name).toBe("@yhnocoder/markdown");
    expect(pkg.private).toBeUndefined();
    expect(pkg.publishConfig).toEqual({ access: "public", provenance: true });
    expect(pkg.type).toBe("module");
    expect(pkg.peerDependencies).toHaveProperty("solid-js");
    expect(pkg.dependencies ?? {}).not.toHaveProperty("solid-js");
  });

  it("every exports target, main and types exist in dist and are packed", () => {
    const all = [...targets(pkg.exports), pkg.main, pkg.types].map((t: string) => path.normalize(t));
    for (const t of all) {
      expect(fs.existsSync(path.join(PKG, t)), t).toBe(true);
      expect(packed, t).toContain(t);
    }
    // each JS entry has its declarations next to it, and the export names one with a types condition
    for (const [key, e] of Object.entries(pkg.exports as Record<string, unknown>)) {
      if (key.endsWith(".css") || key === "./package.json") continue;
      const { types, default: js } = e as { types: string; default: string };
      expect(js, key).toMatch(/^\.\/dist\/.*\.js$/);
      expect(types, key).toBe(js.replace(/\.js$/, ".d.ts"));
    }
  });

  it("packs dist (JS, declarations, stylesheets) and the README, never src or tests", () => {
    expect(packed).toEqual(
      expect.arrayContaining([
        "package.json",
        "README.md",
        "dist/style.css",
        "dist/katex.css",
        "dist/index.js",
        "dist/index.d.ts",
        "dist/editor/index.js",
        "dist/editor/index.d.ts",
      ]),
    );
    expect(packed.filter((f) => !/^(dist\/|package\.json$|README\.md$|LICENSE$)/.test(f))).toEqual([]);
    expect(
      packed.filter((f) => /(^|\/)(src|test)\//.test(f) || (/\.(tsx?|spec\.\w+)$/.test(f) && !f.endsWith(".d.ts"))),
    ).toEqual([]);
    // everything the build made is packed
    expect([...packed].filter((f) => f.startsWith("dist/")).sort()).toEqual(walk(DIST).sort());
  });

  it("the built code imports only its own files and declared packages", () => {
    const declared = new Set([...Object.keys(pkg.dependencies ?? {}), ...Object.keys(pkg.peerDependencies ?? {})]);
    const pkgName = (s: string) =>
      s
        .split("/")
        .slice(0, s.startsWith("@") ? 2 : 1)
        .join("/");
    const bad: string[] = [];
    for (const f of walk(DIST).filter((f) => /\.(js|css)$/.test(f))) {
      const text = fs.readFileSync(path.join(PKG, f), "utf8");
      const specs = f.endsWith(".css")
        ? [...text.matchAll(/@import\s+(?:url\(\s*)?["']?([^"')\s;]+)/g)].map((m) => m[1])
        : [...text.matchAll(/(?:\bfrom\s*|\bimport\s*\(\s*|^\s*import\s+)(["'])([^"']+)\1/gm)].map((m) => m[2]);
      for (const s of specs) {
        if (
          s.startsWith(".")
            ? !fs.existsSync(path.resolve(path.dirname(path.join(PKG, f)), s))
            : !declared.has(pkgName(s))
        )
          bad.push(`${f}: ${s}`);
      }
    }
    expect(bad).toEqual([]);
  });
});
