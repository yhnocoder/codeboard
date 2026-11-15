// Which unit tests a CI run of the Mac app runs (.github/workflows/macos.yml, the app job), from Tests/tiers.json and
// the module graph in Package.swift:
//   node apps/macos/tools/tests/pick.mjs --all              every test (the regular full run)
//   node apps/macos/tools/tests/pick.mjs --base <git ref>   a PR: the working tree against the ref, untracked files too
// A PR runs every target's important tests. A change to a module's sources reaches the test targets of that module and
// of every module that depends on it: a "changed": "whole" target then runs whole, and a "changed": "files" target
// runs each of its areas whose sources name a changed file (none for a file in its "broad"), unless more than
// "maxAreas" of them did. A changed test file runs the suites it declares, and a "whole" target whole.
// --dry prints the selection and runs nothing. Otherwise it prints the same (and adds it to $GITHUB_STEP_SUMMARY) and
// runs swift test --skip-build in apps/macos with it, after swift build --build-tests. Either way it first checks
// tiers.json against Package.swift and the sources: every target and test it names must be there, once, and every
// source of a "files" target's module in an area or its "broad"; after a run it fails when a test product printed no
// summary of its run or ran another number of tests than were picked for it.
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const app = path.resolve(import.meta.dirname, "../..");
const testsDir = path.join(app, "Tests");
const argv = process.argv.slice(2);
const option = (name) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : undefined);
const dry = argv.includes("--dry");
const all = argv.includes("--all");
const base = option("--base");
if (all === Boolean(base)) fail("give either --all or --base <git ref>");

function fail(message) {
  process.stderr.write(`pick.mjs: ${message}\n`);
  process.exit(1);
}

// Swift source with comments taken out and every string literal emptied (interpolations and raw and multi-line
// strings included), so that braces and words in them are not read as code
function code(src) {
  let out = "";
  let i = 0;
  const stringStarts = () => /^#*"/.test(src.slice(i, i + 8));
  const skipString = () => {
    const hashes = /^#*/.exec(src.slice(i))[0];
    i += hashes.length;
    const quote = src.startsWith('"""', i) ? '"""' : '"';
    i += quote.length;
    const close = quote + hashes;
    const interpolation = `\\${hashes}(`;
    while (i < src.length && !src.startsWith(close, i)) {
      if (src.startsWith(interpolation, i)) {
        i += interpolation.length;
        skipInterpolation();
      } else i += src[i] === "\\" && !hashes ? 2 : 1;
    }
    i += close.length;
  };
  const skipInterpolation = () => {
    let depth = 0;
    while (i < src.length) {
      if (stringStarts()) skipString();
      else {
        const c = src[i++];
        if (c === "(") depth++;
        else if (c === ")" && depth-- === 0) return;
      }
    }
  };
  while (i < src.length) {
    if (src.startsWith("//", i)) {
      while (i < src.length && src[i] !== "\n") i++;
    } else if (src.startsWith("/*", i)) {
      let depth = 0;
      do {
        const opens = src.startsWith("/*", i);
        const closes = !opens && src.startsWith("*/", i);
        depth += opens ? 1 : closes ? -1 : 0;
        i += opens || closes ? 2 : 1;
      } while (depth > 0 && i < src.length);
    } else if (stringStarts()) {
      skipString();
      out += '""';
    } else out += src[i++];
  }
  return out;
}

// The tests a Swift file declares, each with the path of the type it is in ("" at file scope; a type with tests in it,
// or in types nested in it, is a suite to Swift Testing, with or without @Suite), and the types the file declares
function declarations(file) {
  const tokens = /[{}]|\b(struct|class|enum|actor|extension|protocol)\s+([A-Za-z_][\w.]*)|@Test\b|\bfunc\s+`?(\w+)/g;
  const scopes = [];
  const tests = [];
  const types = [];
  let pendingType = null;
  let pendingTest = false;
  for (const m of code(fs.readFileSync(file, "utf8")).matchAll(tokens)) {
    const where = scopes.findLast(Boolean) ?? [];
    if (m[0] === "{") {
      scopes.push(pendingType);
      pendingType = null;
    } else if (m[0] === "}") scopes.pop();
    else if (m[1] && !["func", "var", "let", "subscript", "init"].includes(m[2])) {
      const named = m[2].split(".");
      pendingType = m[1] === "extension" ? named : [...where, ...named];
      if (m[1] !== "extension") types.push(pendingType.join("/"));
    } else if (m[0] === "@Test") pendingTest = true;
    else if (m[3] && pendingTest) {
      pendingTest = false;
      tests.push({ suite: where.join("/"), name: m[3] });
    }
  }
  return { tests, types };
}

// The targets Package.swift declares and the targets each depends on (products of other packages left out), so that a
// change to a module reaches the tests of every module above it
function packageGraph() {
  const lines = fs.readFileSync(path.join(app, "Package.swift"), "utf8").split("\n");
  const src = lines.map((l) => l.replace(/^((?:[^"/]|"[^"]*"|\/(?!\/))*)\/\/.*$/, "$1")).join("\n");
  const graph = new Map();
  for (const m of src.matchAll(/\.(target|testTarget|executableTarget)\(/g)) {
    let depth = 0;
    let end = m.index + m[0].length - 1;
    do depth += { "(": 1, ")": -1 }[src[end++]] ?? 0;
    while (depth > 0 && end < src.length);
    const body = src.slice(m.index + m[0].length, end - 1).replace(/\.product\([^)]*\)/g, "");
    const name = /\bname:\s*"([^"]+)"/.exec(body)?.[1];
    const deps = /\bdependencies:\s*\[([^\]]*)\]/.exec(body)?.[1] ?? "";
    if (!name) fail("Package.swift: a target without a name pick.mjs can read");
    if (/\bpath:/.test(body))
      fail(`Package.swift: ${name} has a path, and pick.mjs takes its sources from Sources/${name}`);
    graph.set(name, { kind: m[1], deps: [...deps.matchAll(/"([^"]+)"/g)].map((d) => d[1]) });
  }
  return graph;
}
const graph = packageGraph();
const below = (name, seen = new Set()) => {
  for (const d of graph.get(name)?.deps ?? []) if (!seen.has(d)) below(d, seen.add(d));
  return seen;
};

const tiers = JSON.parse(fs.readFileSync(path.join(testsDir, "tiers.json"), "utf8"));
const maxAreas = tiers.maxAreas;
const folders = fs.readdirSync(testsDir).filter((f) => fs.statSync(path.join(testsDir, f)).isDirectory());
const problems = [];
if (!Number.isInteger(maxAreas) || maxAreas < 1) problems.push(`"maxAreas" is a whole number of at least 1`);
for (const f of folders) if (!tiers.targets[f]) problems.push(`${f}: a test target missing from tiers.json`);
for (const t of Object.keys(tiers.targets)) {
  if (!folders.includes(t)) problems.push(`${t}: no such folder in Tests`);
  if (graph.get(t)?.kind !== "testTarget") problems.push(`${t}: no such test target in Package.swift`);
}
const sourceFiles = (dir) =>
  fs
    .readdirSync(path.join(app, dir), { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e) => path.relative(app, path.join(e.parentPath, e.name)));
const under = (file, dir) => file === dir || file.startsWith(`${dir}/`);

// What a test entry names: a suite (with the suites nested in it) or one test, by its suite path and function
function resolve(t, entry) {
  const asSuite = t.suites.has(entry) ? [{ suite: entry }] : [];
  const cut = entry.lastIndexOf("/");
  const [suite, fn] = cut < 0 ? ["", entry] : [entry.slice(0, cut), entry.slice(cut + 1)];
  const asTest = t.tests.filter((x) => x.suite === suite && x.name === fn);
  const found = [...asSuite, ...asTest];
  if (found.length === 0) problems.push(`${t.name}: ${entry} is neither a suite nor a test there`);
  if (found.length > 1) problems.push(`${t.name}: ${entry} names ${found.length} things there (a suite or overloads)`);
  return found[0];
}

const targets = Object.entries(tiers.targets)
  .filter(([name]) => folders.includes(name) && graph.get(name)?.kind === "testTarget")
  .map(([name, tier]) => {
    const module = name.replace(/Tests$/, "");
    const reaches = below(name);
    if (!graph.get(name).deps.includes(module))
      problems.push(`${name}: Package.swift does not make it depend on ${module}`);
    const files = sourceFiles(`Tests/${name}`).filter((f) => f.endsWith(".swift"));
    const tests = files.flatMap((file) => declarations(path.join(app, file)).tests.map((x) => ({ ...x, file })));
    const suites = new Set(tests.flatMap((x) => x.suite.split("/").map((_, i, p) => p.slice(0, i + 1).join("/"))));
    suites.delete("");
    const t = { name, tier, module, reaches, files, tests, suites };
    for (const p of tier.extra ?? []) if (!fs.existsSync(path.join(app, p))) problems.push(`${name}: no path ${p}`);
    if (!["whole", "files"].includes(tier.changed)) problems.push(`${name}: "changed" is "whole" or "files"`);
    if (tier.changed !== "files" && (tier.areas || tier.broad))
      problems.push(`${name}: only a target with "changed": "files" has areas and "broad"`);
    const important = tier.important === "whole" ? [] : tier.important;
    if (!Array.isArray(important)) problems.push(`${name}: "important" is "whole" or a list`);
    t.resolved = important.map((entry) => resolve(t, entry));
    const where = (p, what) => {
      if (!fs.existsSync(path.join(app, "Sources", p))) problems.push(`${name}: ${what} names Sources/${p}, not there`);
      else if (!reaches.has(p.split("/")[0]))
        problems.push(`${name}: ${what} names ${p}, a module its tests do not use`);
    };
    t.broad = tier.broad ?? [];
    for (const p of t.broad) {
      where(p, '"broad"');
      if (!under(`Sources/${p}`, `Sources/${module}`)) problems.push(`${name}: "broad" names ${p}, outside ${module}`);
    }
    t.areas = Object.entries(tier.areas ?? {}).map(([area, a]) => {
      if (!a.sources?.length || !a.tests?.length) problems.push(`${name}: area ${area} needs sources and tests`);
      for (const p of a.sources ?? []) {
        where(p, `area ${area}`);
        if (t.broad.some((b) => under(p, b) || under(b, p)))
          problems.push(`${name}: ${p} is in area ${area} and "broad"`);
      }
      return { area, sources: a.sources ?? [], resolved: (a.tests ?? []).map((entry) => resolve(t, entry)) };
    });
    return t;
  });

// Every source of a module whose tests run by areas is in an area, of its own tests or of the tests above it, or in
// its "broad"; a new file in neither would quietly run only the important tests
const named = targets.flatMap((t) => t.areas.flatMap((a) => a.sources));
for (const t of targets.filter((x) => x.tier.changed === "files"))
  for (const file of sourceFiles(`Sources/${t.module}`)) {
    const p = file.slice("Sources/".length);
    if (!named.some((s) => under(p, s)) && !t.broad.some((b) => under(p, b)))
      problems.push(`${t.name}: ${file} is in no area and not in "broad"; add it to the area its tests are in`);
  }
if (problems.length) fail(`Tests/tiers.json does not match the sources:\n  ${problems.join("\n  ")}`);

// Swift Testing matches a filter against a test's ID: the module, then the suites and the function with its argument
// labels, written Module.Suite/function(label:) (either separator is accepted). An ID can end in its source location,
// Module/File.swift:line:column, so a suite's pattern must not take a file of the same name for the suite
const id = (module, suite) => [module, ...(suite ? suite.split("/") : [])].join("[./]");
const wholeFilter = (module) => `${module}[./]`;
const suiteFilter = (module, suite) => `${id(module, suite)}[./](?!swift:)`;
const testFilter = (module, t) => `${id(module, t.suite)}[./]${t.name}\\(`;

const changed = [];
if (base) {
  const git = (...args) =>
    execFileSync("git", ["-C", app, ...args], { encoding: "utf8" })
      .split("\n")
      .filter(Boolean);
  try {
    changed.push(
      ...git("diff", "--name-only", "--relative", base),
      ...git("ls-files", "--others", "--exclude-standard"),
    );
  } catch {
    fail(`cannot compare with ${base}`);
  }
}
const extra = targets.flatMap((t) => (t.tier.extra ?? []).map((p) => ({ path: p, module: t.module })));
const moduleOf = (file) => {
  const lib = /^Sources\/([^/]+)\//.exec(file)?.[1];
  if (graph.get(lib)?.kind === "target") return lib;
  return extra.find((e) => under(file, e.path))?.module;
};
const sourceChanges = changed.map((file) => ({ file, module: moduleOf(file) })).filter((c) => c.module);
const listed = (files, most = 3) =>
  files.slice(0, most).join(", ") + (files.length > most ? ` and ${files.length - most} more` : "");

const lines = [];
const filters = [];
const expected = [];
let filtered = 0;
for (const t of targets) {
  if (all) {
    lines.push(`${t.name}: all ${t.tests.length} tests`);
    expected.push({ name: t.name, count: t.tests.length });
    continue;
  }
  const ownTests = changed.filter((f) => under(f, `Tests/${t.name}`));
  const hits = sourceChanges.filter((c) => c.module === t.module || t.reaches.has(c.module));
  const why = [];
  if (ownTests.length || hits.some((c) => c.module === t.module))
    why.push(`changed: ${listed([...hits.filter((c) => c.module === t.module).map((c) => c.file), ...ownTests])}`);
  for (const m of new Set(hits.map((c) => c.module).filter((m) => m !== t.module)))
    why.push(`depends on ${m}: ${listed(hits.filter((c) => c.module === m).map((c) => c.file))}`);
  if (t.tier.important === "whole" || (t.tier.changed === "whole" && why.length)) {
    lines.push(`${t.name}: all ${t.tests.length} tests (${why.join("; ") || "important"})`);
    filters.push(wholeFilter(t.name));
    filtered += t.tests.length;
    expected.push({ name: t.name, count: t.tests.length });
    continue;
  }
  const picked = new Map();
  const matching = (r) => t.tests.filter((x) => (r.name ? x === r : under(x.suite, r.suite)));
  const add = (r) => {
    const filter = r.name ? testFilter(t.name, r) : suiteFilter(t.name, r.suite);
    picked.set(filter, [...(picked.get(filter) ?? []), ...matching(r)]);
  };
  t.resolved.forEach(add);
  const reasons = [`${t.resolved.length} important entries (${new Set([...picked.values()].flat()).size} tests)`];
  if (t.tier.changed === "files") {
    const relative = hits.map((c) => ({ ...c, p: c.file.replace(/^Sources\//, "") }));
    const touched = t.areas
      .map((a) => ({ ...a, by: relative.filter((c) => a.sources.some((s) => under(c.p, s))) }))
      .filter((a) => a.by.length);
    const broad = relative.filter((c) => t.broad.some((b) => under(c.p, b))).map((c) => c.p);
    const unnamed = relative.filter((c) => !touched.some((a) => a.by.includes(c)) && !broad.includes(c.p));
    if (touched.length > maxAreas)
      reasons.push(
        `${touched.length} areas changed (${touched.map((a) => a.area).join(", ")}), more than ${maxAreas}: ` +
          "only the important tests and changed test files run here, and the regular full run covers the rest",
      );
    else
      for (const a of touched) {
        a.resolved.forEach(add);
        const count = new Set(a.resolved.flatMap(matching)).size;
        const lower = [...new Set(a.by.map((c) => c.module).filter((m) => m !== t.module))];
        const through = lower.length ? ` (depends on ${lower.join(", ")})` : "";
        reasons.push(`area ${a.area} (${count} tests) for ${listed(a.by.map((c) => c.p))}${through}`);
      }
    if (broad.length) reasons.push(`used all over, important tests only: ${listed(broad)}`);
    for (const m of new Set(unnamed.map((c) => c.module))) {
      const files = listed(unnamed.filter((c) => c.module === m).map((c) => c.p));
      reasons.push(`${m === t.module ? "" : `depends on ${m}, `}important tests only: no area here names ${files}`);
    }
    const fromFiles = [];
    for (const file of ownTests.filter((f) => t.files.includes(f) && fs.existsSync(path.join(app, f)))) {
      const { types } = declarations(path.join(app, file));
      const suites = types.filter((s) => t.suites.has(s) && !types.some((o) => o !== s && under(s, o)));
      const loose = t.tests.filter((x) => x.file === file && !suites.some((s) => under(x.suite, s)));
      suites.forEach((suite) => add({ suite }));
      loose.forEach(add);
      const names = new Set([...suites, ...loose.map((x) => (x.suite ? `${x.suite}/${x.name}` : x.name))]);
      if (names.size) fromFiles.push(`${path.basename(file)} (${[...names].join(", ")})`);
    }
    if (fromFiles.length) reasons.push(`from changed test files: ${fromFiles.join("; ")}`);
  }
  const count = new Set([...picked.values()].flat()).size;
  lines.push(`${t.name}: ${count} of ${t.tests.length} tests`, ...reasons.map((r) => `  ${r}`));
  filters.push(...picked.keys());
  filtered += count;
  if (count) expected.push({ name: t.name, count });
}
const args = ["test", "--skip-build", ...filters.flatMap((f) => ["--filter", f])];
const total = targets.reduce((a, t) => a + t.tests.length, 0);
const summary = [
  all
    ? `Every test: ${total}`
    : `Against ${base}: ${changed.length} files changed in apps/macos, ${filtered} of ${total} tests`,
  ...lines.map((l) => `  ${l}`),
  `swift ${args.map((a) => (/^[\w./-]+$/.test(a) ? a : `'${a}'`)).join(" ")}`,
].join("\n");
process.stdout.write(`${summary}\n`);
if (dry) process.exit(0);
if (process.env.GITHUB_STEP_SUMMARY)
  fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `### Mac app unit tests\n\n\`\`\`\n${summary}\n\`\`\`\n`);

// A test process can end with status 0 before it ran all its tests (seen when something under test stopped the main
// run loop): it prints no summary, and swift test still exits 0. So every product's summary line must be there, with
// the number of tests picked for it. The lines name no product, so the numbers are compared as a multiset; a product
// with nothing picked is left out on both sides
const output = [];
const status = await new Promise((done) => {
  const run = spawn("swift", args, { cwd: app, stdio: ["inherit", "pipe", "pipe"] });
  const pass = (to) => (chunk) => {
    to.write(chunk);
    output.push(chunk);
  };
  run.stdout.on("data", pass(process.stdout));
  run.stderr.on("data", pass(process.stderr));
  run.on("error", (e) => {
    process.stderr.write(`pick.mjs: cannot run swift: ${e.message}\n`);
    done(1);
  });
  run.on("close", (code) => done(code ?? 1));
});
const text = Buffer.concat(output)
  .toString("utf8")
  .replace(/\x1b\[[0-9;]*m/g, "");
const reported = [...text.matchAll(/Test run with (\d+) tests? in \d+ suites? (?:passed|failed)/g)]
  .map((m) => Number(m[1]))
  .filter((n) => n > 0);
const left = [...reported];
let unmatched = 0;
for (const { count } of expected) {
  if (left.includes(count)) left.splice(left.indexOf(count), 1);
  else unmatched++;
}
const silent = expected.length - reported.length;
const problem =
  silent > 0
    ? `${silent} of ${expected.length} test products ended without the summary of their run: a test process ` +
      "stopped early, and the tests it had not reached did not run"
    : unmatched || left.length
      ? "the test products ran other numbers of tests than were picked"
      : "";
const sides = [
  `  picked:   ${expected.map((e) => `${e.name} ${e.count}`).join(", ")}`,
  `  reported: ${reported.join(", ") || "nothing"}`,
].join("\n");
process.exitCode = status;
if (problem && status === 0) {
  process.stderr.write(`pick.mjs: ${problem}\n${sides}\n`);
  if (process.env.GITHUB_STEP_SUMMARY)
    fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `**${problem}**\n\n\`\`\`\n${sides}\n\`\`\`\n`);
  process.exitCode = 1;
} else if (silent > 0) process.stderr.write(`pick.mjs: ${problem}\n`);
