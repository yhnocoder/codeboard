// Writes the fixtures of the Swift analysis tests (apps/macos/Tests/CodeBoardAnalysisTests/Fixtures) from the
// TypeScript analysis, so that the Swift tests need neither Node nor the examples/ submodules:
//   - the inputs of packages/analysis/test/analysis.test.ts's recorded results: nano-vllm's Python files, copied
//     unchanged (with nano-vllm's LICENSE), and the test's inline samples, as files under samples/;
//   - expected/<name>.json: what packages/analysis's analyze gives for each (keys sorted, undefined fields left out);
//   - cases.json: each case's name, language, source and expected file.
// The inputs are taken from analysis.test.ts itself: it is run with a stand-in for vitest that records what each
// recorded result was analysed from.
//
// Run from the repository root, after `npm install` and `npm run examples`:
//   node apps/macos/tools/analysis/fixtures.mjs
// Run it again whenever packages/analysis changes, and check that `npx vitest run` in packages/analysis passes first:
// the fixtures are only as right as the snapshots that test keeps.
import { build } from "esbuild";
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "../../../..");
const analysis = join(root, "packages/analysis");
const nano = join(root, "examples/nano-vllm");
const out = join(root, "apps/macos/Tests/CodeBoardAnalysisTests/Fixtures");
const work = join(root, "test-out/analysis-fixtures");

// symbols.test.ts reads nano-vllm at this commit; the Swift tests read the same files from the fixtures
const pinned = "bb823b3";
const head = execFileSync("git", ["-C", nano, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
if (!head.startsWith(pinned)) throw new Error(`examples/nano-vllm is at ${head}, not ${pinned}`);

rmSync(work, { recursive: true, force: true });
mkdirSync(work, { recursive: true });
writeFileSync(
  join(work, "vitest.mjs"),
  `export const recorded = [];
const suites = [];
let current;
export const beforeAll = (fn) => suites.push({ before: fn });
export function describe(name, fn) {
  if (name !== "analysis matches the recorded result") return;
  current = [];
  fn();
  suites.push({ tests: current });
}
export const it = (name, fn) => current?.push({ name, fn });
export function expect(value) {
  return {
    toBeGreaterThan(n) {
      if (!(value > n)) throw new Error(value + " is not greater than " + n);
    },
    toMatchFileSnapshot(path) {
      recorded.push({ path, value, input: globalThis.lastAnalyzed });
    },
  };
}
export async function runAll() {
  for (const s of suites) if (s.before) await s.before();
  for (const s of suites) for (const t of s.tests ?? []) await t.fn();
}
`,
);
writeFileSync(
  join(work, "src.mjs"),
  `import * as real from ${JSON.stringify(join(analysis, "src/index.ts"))};
export * from ${JSON.stringify(join(analysis, "src/index.ts"))};
export function analyze(lang, text, o) {
  globalThis.lastAnalyzed = { lang, text };
  return real.analyze(lang, text, o);
}
`,
);
writeFileSync(
  join(work, "entry.mjs"),
  `import { runAll, recorded } from "vitest";
import ${JSON.stringify(join(analysis, "test/analysis.test.ts"))};
await runAll();
export { recorded };
`,
);
const redirect = {
  name: "redirect",
  setup(b) {
    b.onResolve({ filter: /^vitest$/ }, () => ({ path: join(work, "vitest.mjs") }));
    b.onResolve({ filter: /^\.\.\/src$/ }, (a) =>
      a.importer.endsWith("analysis.test.ts") ? { path: join(work, "src.mjs") } : undefined,
    );
  },
};
await build({
  entryPoints: [join(work, "entry.mjs")],
  bundle: true,
  platform: "node",
  format: "esm",
  // as deep under the root as analysis.test.ts, whose import.meta.url finds examples/ from there
  outfile: join(work, "test/bundle.mjs"),
  external: ["@vscode/tree-sitter-wasm"],
  plugins: [redirect],
  logLevel: "error",
});
const { recorded } = await import(pathToFileURL(join(work, "test/bundle.mjs")).href);
if (recorded.length < 20) throw new Error(`only ${recorded.length} recorded results`);

/** JSON with sorted keys; undefined fields are left out as JSON.stringify does */
const sortKeys = (v) =>
  Array.isArray(v)
    ? v.map(sortKeys)
    : v && typeof v === "object"
      ? Object.fromEntries(
          Object.keys(v)
            .sort()
            .filter((k) => v[k] !== undefined)
            .map((k) => [k, sortKeys(v[k])]),
        )
      : v;

rmSync(out, { recursive: true, force: true });
const write = (rel, data) => {
  mkdirSync(dirname(join(out, rel)), { recursive: true });
  writeFileSync(join(out, rel), data);
};
const cases = [];
for (const r of recorded) {
  const name = r.path.replace(/^\.\/__snapshots__\/analysis\//, "").replace(/\.snap$/, "");
  if (!r.input) throw new Error(`${name}: no analyze call recorded`);
  let source;
  if (name.startsWith("nano-vllm/")) {
    source = name;
    const file = join(nano, name.slice("nano-vllm/".length));
    if (readFileSync(file, "utf8") !== r.input.text) throw new Error(`${name} was analysed from other text`);
    mkdirSync(dirname(join(out, source)), { recursive: true });
    copyFileSync(file, join(out, source));
  } else {
    source = `samples/${name}`;
    write(source, r.input.text);
  }
  const expected = `expected/${name}.json`;
  write(expected, `${JSON.stringify(sortKeys(r.value), null, 2)}\n`);
  cases.push({ name, lang: r.input.lang, source, expected });
}
copyFileSync(join(nano, "LICENSE"), join(out, "nano-vllm/LICENSE"));
write("cases.json", `${JSON.stringify(cases, null, 2)}\n`);
console.log(`${cases.length} cases written to ${out}`);
