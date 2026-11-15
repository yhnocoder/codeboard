// Which unit tests a CI run of the Mac app runs (.github/workflows/macos.yml, the app job), from Tests/tiers.json:
//   node apps/macos/tools/tests/pick.mjs --all              every test (the regular full run)
//   node apps/macos/tools/tests/pick.mjs --base <git ref>   a PR: the important tests, the whole of each target whose
//                                                          module or tests changed, and for a target that runs by
//                                                          files the suites declared in its changed test files
//                                                          (the working tree against the ref, untracked files too)
// --dry prints the selection and runs nothing. Otherwise it prints the same (and adds it to $GITHUB_STEP_SUMMARY) and
// runs swift test --skip-build in apps/macos with it, after swift build --build-tests. Either way it first checks every
// name in tiers.json against the test sources and fails on one that is gone or ambiguous; after a run it fails when a
// test product printed no summary of its run or ran another number of tests than were picked for it.
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

const tiers = JSON.parse(fs.readFileSync(path.join(testsDir, "tiers.json"), "utf8"));
const folders = fs.readdirSync(testsDir).filter((f) => fs.statSync(path.join(testsDir, f)).isDirectory());
const problems = [];
for (const f of folders) if (!tiers[f]) problems.push(`${f}: a test target missing from tiers.json`);
for (const t of Object.keys(tiers)) if (!folders.includes(t)) problems.push(`${t}: no such folder in Tests`);

const targets = Object.entries(tiers)
  .filter(([name]) => folders.includes(name))
  .map(([name, tier]) => {
    const files = fs
      .readdirSync(path.join(testsDir, name), { recursive: true })
      .filter((f) => f.endsWith(".swift"))
      .map((f) => `Tests/${name}/${f}`);
    const tests = files.flatMap((file) => declarations(path.join(app, file)).tests.map((t) => ({ ...t, file })));
    const suites = new Set(tests.flatMap((t) => t.suite.split("/").map((_, i, p) => p.slice(0, i + 1).join("/"))));
    suites.delete("");
    for (const s of tier.sources) if (!fs.existsSync(path.join(app, s))) problems.push(`${name}: no source path ${s}`);
    if (!["whole", "files"].includes(tier.changed)) problems.push(`${name}: "changed" is "whole" or "files"`);
    const important = tier.important === "whole" ? [] : tier.important;
    if (!Array.isArray(important)) problems.push(`${name}: "important" is "whole" or a list`);
    const resolved = important.map((entry) => {
      const asSuite = suites.has(entry) ? [{ suite: entry }] : [];
      const cut = entry.lastIndexOf("/");
      const [suite, fn] = cut < 0 ? ["", entry] : [entry.slice(0, cut), entry.slice(cut + 1)];
      const asTest = tests.filter((t) => t.suite === suite && t.name === fn);
      const found = [...asSuite, ...asTest];
      if (found.length === 0) problems.push(`${name}: ${entry} is neither a suite nor a test there`);
      if (found.length > 1)
        problems.push(`${name}: ${entry} names ${found.length} things there (a suite or overloads)`);
      return found[0];
    });
    return { name, tier, files, tests, suites, resolved };
  });
if (problems.length) fail(`Tests/tiers.json does not match the test sources:\n  ${problems.join("\n  ")}`);

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
const under = (file, dir) => file === dir || file.startsWith(`${dir}/`);

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
  const own = changed.filter((f) => under(f, `Tests/${t.name}`) || t.tier.sources.some((s) => under(f, s)));
  if (t.tier.important === "whole" || (t.tier.changed === "whole" && own.length)) {
    const why = own.length
      ? `changed: ${own.slice(0, 3).join(", ")}${own.length > 3 ? ` and ${own.length - 3} more` : ""}`
      : "important";
    lines.push(`${t.name}: all ${t.tests.length} tests (${why})`);
    filters.push(wholeFilter(t.name));
    filtered += t.tests.length;
    expected.push({ name: t.name, count: t.tests.length });
    continue;
  }
  const picked = new Map();
  const add = (r) => {
    const matched = t.tests.filter((x) => (r.name ? x === r : under(x.suite, r.suite)));
    const filter = r.name ? testFilter(t.name, r) : suiteFilter(t.name, r.suite);
    picked.set(filter, [...(picked.get(filter) ?? []), ...matched]);
  };
  t.resolved.forEach(add);
  const important = new Set([...picked.values()].flat()).size;
  const extra = [];
  if (t.tier.changed === "files") {
    for (const file of own.filter((f) => t.files.includes(f) && fs.existsSync(path.join(app, f)))) {
      const { types } = declarations(path.join(app, file));
      const suites = types.filter((s) => t.suites.has(s) && !types.some((o) => o !== s && under(s, o)));
      const loose = t.tests.filter((x) => x.file === file && !suites.some((s) => under(x.suite, s)));
      suites.forEach((suite) => add({ suite }));
      loose.forEach(add);
      const names = new Set([...suites, ...loose.map((x) => (x.suite ? `${x.suite}/${x.name}` : x.name))]);
      if (names.size) extra.push(`${path.basename(file)} (${[...names].join(", ")})`);
    }
  }
  const count = new Set([...picked.values()].flat()).size;
  const entries = `${t.resolved.length} important entries (${important} tests)`;
  const files = extra.length ? `; from changed test files: ${extra.join("; ")}` : "";
  lines.push(`${t.name}: ${count} of ${t.tests.length} tests: ${entries}${files}`);
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
