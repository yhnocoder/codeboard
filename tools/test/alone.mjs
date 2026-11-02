// Passing alone, bounded. harness.mjs runs a scenario that failed beside others once more on its own and counts a pass there as a
// pass ("alone"): some scenarios lose to the CPU load of the others. That can also hide a race that only shows under load, so the
// regular runs keep count (impact/alone.json on the ci-screenshots branch, written by publish-impact.sh): a scenario that passed
// only alone in ALONE_LIMIT regular runs in a row gets no alone retry any more, anywhere (npm run check, PR CI, the regular run),
// so it fails until it passes beside the others again (or is made a solo scenario in tiers.json, for a reason written there).
// No dependencies: the regular report uses it without npm ci.

export const ALONE_LIMIT = 3;

/**
 * prev: { scenario: regular runs in a row it passed only alone }, results: this regular run's → the counts after it. A scenario
 * that already gets no alone retry cannot pass alone, so its failure keeps its count (it stays strict) and only a pass beside
 * the others clears it; for the rest a pass beside the others or a failure outright starts over
 */
export function aloneStreaks(prev, results) {
  const strict = new Set(noAloneRetry(prev));
  const out = {};
  for (const r of results)
    if (r.alone) out[r.name] = (prev?.[r.name] ?? 0) + 1;
    else if (!r.ok && strict.has(r.name)) out[r.name] = prev[r.name];
  return out;
}

/** The scenarios that get no alone retry: alone in ALONE_LIMIT regular runs in a row */
export const noAloneRetry = (streaks) =>
  Object.entries(streaks ?? {})
    .filter(([, n]) => n >= ALONE_LIMIT)
    .map(([name]) => name)
    .sort();
