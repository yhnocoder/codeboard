// Feature areas (packages/board/test/tiers.json "areas"): which files belong to an area, and the group of scenarios that stands
// for it. No dependencies, so that the nightly report (which runs without npm ci) can use it too.

/** A glob as a RegExp over a repository path: ** any depth, * and ? within one path segment, {a,b} alternatives */
export function globRe(g) {
  const body = g.replace(/[.+^$()|[\]\\]/g, "\\$&")
    .replace(/\*\*\/?/g, "\0").replace(/\*/g, "[^/]*").replace(/\?/g, "[^/]").replace(/\0/g, ".*")
    .replace(/\{([^}]*)\}/g, (_, alts) => `(?:${alts.split(",").join("|")})`);
  return new RegExp(`^${body}$`);
}
const cache = new Map();
const matches = (globs, file) => globs.some((g) => (cache.has(g) ? cache : cache.set(g, globRe(g))).get(g).test(file));

/** Source files and scenario specs: each must belong to an area or to broad (a unit test checks this) */
export const OWNED = /^packages\/(board|core|host|markdown|analysis)\/src\/|^packages\/board\/test\/scenarios\/[^/]+\.spec\.ts$/;

/**
 * Which areas changed files touch. → { areas: { name: [the files that touch it] }, broad: [files], unplaced: [owned files no area
 * holds, counted as broad] }. A file broad holds is broad only, even when an area's glob matches it too. Other files (docs, unit
 * tests, the extension, tiers.json itself, which changes no code a scenario runs) touch nothing: smoke still runs.
 */
export function areasOf(files, tiers) {
  const areas = {}, broad = [], unplaced = [];
  const touch = (a, f) => (areas[a] ??= []).push(f);
  for (const f of files) {
    if (matches(tiers.broad?.files ?? [], f)) { broad.push(f); continue; }
    const hit = Object.entries(tiers.areas ?? {}).filter(([, a]) => matches(a.files, f)).map(([n]) => n);
    for (const a of hit) touch(a, f);
    if (!hit.length && OWNED.test(f)) unplaced.push(f);
  }
  return { areas, broad, unplaced };
}

/** The areas (and broad) that hold a file */
export const holders = (file, tiers) => [
  ...(matches(tiers.broad?.files ?? [], file) ? ["broad"] : []),
  ...Object.entries(tiers.areas ?? {}).filter(([, a]) => matches(a.files, file)).map(([n]) => n),
];

/**
 * Each group's time beside smoke (its smoke scenarios run anyway), against tiers.json "limits" (seconds): every area group and
 * broad within limits.area, smoke within limits.smoke, and smoke with the three largest groups within limits.local, the harness
 * share of npm run check's 90 s. ms: scenario name → its time. → { groups: [{ name, ms, over }], smokeMs, typicalMs, over: [lines] }
 */
export function groupTimes(tiers, ms) {
  const lim = tiers.limits ?? {}, smoke = new Set(tiers.smoke ?? []);
  const sum = (names) => names.reduce((t, n) => t + ms(n), 0);
  const groups = [["broad", tiers.broad], ...Object.entries(tiers.areas ?? {})].filter(([, g]) => g)
    .map(([name, g]) => { const t = sum(g.scenarios.filter((n) => !smoke.has(n))); return { name, ms: t, over: t > (lim.area ?? Infinity) * 1000 }; });
  const smokeMs = sum([...smoke]);
  const typicalMs = smokeMs + groups.map((g) => g.ms).sort((a, b) => b - a).slice(0, 3).reduce((a, b) => a + b, 0);
  const s = (t) => Math.round(t / 1000);
  const over = [
    ...groups.filter((g) => g.over).map((g) => `${g.name}: ${s(g.ms)} s beside smoke, over the ${lim.area} s limit`),
    ...(smokeMs > (lim.smoke ?? Infinity) * 1000 ? [`smoke: ${s(smokeMs)} s, over the ${lim.smoke} s limit`] : []),
    ...(typicalMs > (lim.local ?? Infinity) * 1000 ? [`smoke and the three largest groups: ${s(typicalMs)} s, over the ${lim.local} s of npm run check`] : []),
  ];
  return { groups, smokeMs, typicalMs, over };
}
