// The frames of an animated SVG that does not say how many it has (no data-steps): inferred from its animations' own timelines,
// so that the control bar steps through the scenes the SVG really shows. Pure: the CSS animations (cssTrack) and SMIL elements
// (smilTracks) are read into Tracks, and svgFrames turns the Tracks into a frame list. The same SVG always gives the same list, so a
// saved {frame=N} lands on the same time.
//   The cycle: every animation that repeats forever has a period (one iteration, two when it alternates); the cycle's repeating part
//   is their least common multiple, in whole ms. When that is over MAX_CYCLE (it explodes for unrelated durations) it is the longest
//   single period instead. Before it comes an intro, up to the last start of a repeating animation (a positive delay / begin) and
//   the end of every animation that does not repeat forever. With nothing repeating forever the cycle is the intro alone, its
//   last moment included (the pose the SVG stays on).
//   Cuts: a change that is instant (a steps() boundary, a discrete SMIL value, a <set>'s begin, an iteration that ends on another
//   value than it starts with, an animation's value dropped at its end) or interpolated over less than CUT_MS. Changes that take
//   longer are motion. Cuts of all the animations are merged (overlapping, or within DEDUP_MS).
//   Frames: the scenes between cuts, one per cut, each stood on at its settled moment (just before the next cut, so what moves in
//   it has arrived); motion inside a scene adds no frame. Only when the cuts give fewer than two scenes (a smooth loop, perhaps
//   snapping back once per cycle) is the cycle sampled instead: at SAMPLE_FPS, plus every cut and every motion's ends, a sample
//   dropped near one of those, each stood on as it starts. At most MAX_FRAMES, picked evenly by index from the full list when over.
import { clockMs } from "./animsvg";

/** One animation's timeline. Times in ms; changes in fractions of one iteration (0..1) */
export type Track = {
  dur: number;
  /** When its first iteration starts (CSS delay, SMIL begin); negative: already that far into it at 0 */
  delay: number;
  /** Infinity: forever */
  iterations: number;
  /** Every other iteration runs backwards (CSS alternate); reverse: every one does (or the odd ones, with alternate) */
  alternate?: boolean;
  reverse?: boolean;
  /** Instant changes inside an iteration (0: an iteration starts on another value than the last one ended with) */
  jumps: number[];
  /** Interpolated changes inside an iteration */
  ramps: [number, number][];
  /** Its value is dropped (not held) once it has ended */
  dropsAtEnd?: boolean;
};

export type SvgFrames = {
  /** When each frame starts on the cycle, ascending (time 0 is in the last frame when the first starts later) */
  starts: number[];
  /** The time each frame is stood on */
  stands: number[];
  /** The intro's length, and the repeating part's (0: nothing repeats; the SVG then stays on its last frame) */
  intro: number;
  period: number;
};

/** A change interpolated over less than this (ms) is a cut, not motion */
const CUT_MS = 100;
const SAMPLE_FPS = 12;
export const MAX_FRAMES = 240;
/** Over this (ms) the LCM of the periods gives way to the longest one: 20 s is MAX_FRAMES at SAMPLE_FPS */
const MAX_CYCLE = (MAX_FRAMES / SAMPLE_FPS) * 1000;
const DEDUP_MS = 1;
/** How far from a cut a frame is stood on: before the next cut (settled), or after its start (a sample) */
const LAND_MS = 0.5;
/** Shorter iterations are not stepped through */
const MIN_DUR = 1;
/** Changes generated at most (a tiny period over a long cycle) */
const MAX_POINTS = 100_000;

const gcd = (a: number, b: number): number => (b ? gcd(b, a % b) : a);

export function svgFrames(tracks: Track[]): SvgFrames | null {
  const live = tracks.filter((t) => Number.isFinite(t.delay) && t.iterations > 0 && t.dur >= 0);
  if (!live.length) return null;
  const forever = live.filter((t) => t.iterations === Infinity && t.dur >= MIN_DUR);
  const periodOf = (t: Track) => Math.max(1, Math.round(t.dur * (t.alternate ? 2 : 1)));
  let period = 0;
  if (forever.length) {
    const ps = forever.map(periodOf);
    period = ps.reduce((l, p) => (l > MAX_CYCLE ? l : (l / gcd(l, p)) * p), 1);
    if (period > MAX_CYCLE) period = Math.max(...ps);
  }
  const intro = Math.max(
    0,
    ...forever.map((t) => t.delay),
    ...live.filter((t) => t.iterations !== Infinity).map((t) => t.delay + t.dur * t.iterations),
  );
  const end = intro + period;
  /** A time on the timeline, onto the cycle: past its end, the repeating part wraps */
  const wrap = (t: number) => (period && t >= end ? intro + ((t - intro) % period) : t);
  const inCycle = (t: number) => t >= 0 && (period ? t < end : t <= end);

  const cuts: [number, number][] = [];
  const moves: [number, number][] = [];
  const cut = (a: number, b: number) => {
    const w = wrap(b);
    if (inCycle(w)) cuts.push([w - (b - a), w]);
  };
  for (const t of live) {
    const last = t.iterations === Infinity ? Infinity : t.delay + t.dur * t.iterations;
    if (t.dur < MIN_DUR) {
      // a <set> with no duration: one change, when it begins
      cut(t.delay, t.delay);
      continue;
    }
    // from the iteration that is on at 0 up to one that starts past the cycle (its first change can wrap onto the cycle)
    const k0 = Math.max(0, Math.floor(-t.delay / t.dur));
    for (let k = k0; cuts.length + moves.length < MAX_POINTS; k++) {
      const s = t.delay + k * t.dur;
      if (s >= last || s > end + t.dur) break;
      const back = !!t.reverse !== (!!t.alternate && k % 2 === 1);
      const at = (f: number) => s + (back ? 1 - f : f) * t.dur;
      for (const f of t.jumps) if (at(f) <= last) cut(at(f), at(f));
      for (const [a, b] of t.ramps) {
        const x = Math.min(at(a), at(b)),
          y = Math.max(at(a), at(b));
        if (y > last) continue;
        if (y - x < CUT_MS) cut(x, y);
        else if (y > 0 && x < end) moves.push([Math.max(0, x), Math.min(end, y)]);
      }
    }
    if (t.dropsAtEnd && last !== Infinity) cut(last, last);
  }

  // merged: sorted by where each ends, one that starts before the last kept ends (within DEDUP_MS) joins it
  cuts.sort((p, q) => p[1] - q[1] || p[0] - q[0]);
  const merged: [number, number][] = [];
  for (const c of cuts) {
    const m = merged[merged.length - 1];
    if (m && c[0] <= m[1] + DEDUP_MS) {
      m[0] = Math.min(m[0], c[0]);
      m[1] = Math.max(m[1], c[1]);
    } else merged.push([c[0], c[1]]);
  }
  // the last cut runs over the cycle's end into the first one (a repeating cycle with no intro)
  if (period && !intro && merged.length > 1) {
    const f = merged[0],
      l = merged[merged.length - 1];
    if (f[0] + period <= l[1] + DEDUP_MS) {
      f[0] = Math.min(f[0], l[0] - period);
      merged.pop();
    }
  }
  // what comes before the first change is a scene of its own, unless the cycle wraps into it
  if ((!period || intro) && (!merged.length || merged[0][1] > DEDUP_MS)) merged.unshift([0, 0]);

  let f: Pick<SvgFrames, "starts" | "stands">;
  if (merged.length >= 2) {
    // a scene stands on its settled moment: just before the next cut (the next in the repeating part for the last), or on the
    // end when nothing repeats
    const again = merged.find((c) => c[1] >= intro) ?? merged[0];
    f = {
      starts: merged.map((c) => c[1]),
      stands: merged.map((c, i) => {
        const next = merged[i + 1]?.[0] ?? (period ? again[0] + period : end + 2 * LAND_MS);
        return Math.max(c[1], next - LAND_MS);
      }),
    };
  } else {
    const gap = 1000 / SAMPLE_FPS;
    const marks = dedup([0, ...merged.map((c) => Math.max(0, c[1])), ...moves.flat()].filter(inCycle));
    const samples: number[] = [];
    if (moves.length)
      for (let i = 0, s = 0; s < end; s = ++i * gap)
        if (moves.some(([a, b]) => s > a && s < b) && !near(marks, s, gap / 3)) samples.push(s);
    const starts = dedup([...marks, ...samples]);
    f = { starts, stands: starts.map((s) => s + LAND_MS) };
  }
  const n = f.starts.length;
  if (n > MAX_FRAMES) {
    const pick = Array.from({ length: MAX_FRAMES }, (_, i) => Math.floor((i * n) / MAX_FRAMES));
    f = { starts: pick.map((i) => f.starts[i]), stands: pick.map((i) => f.stands[i]) };
  }
  return { ...f, intro, period };
}

/** Sorted, with points closer than DEDUP_MS to the one kept before merged into it */
function dedup(ts: number[]): number[] {
  const out: number[] = [];
  for (const t of [...ts].sort((a, b) => a - b)) if (!out.length || t - out[out.length - 1] >= DEDUP_MS) out.push(t);
  return out;
}
/** Whether a sorted list has a point within d of t */
function near(sorted: number[], t: number, d: number): boolean {
  let lo = 0,
    hi = sorted.length;
  while (lo < hi) {
    const m = (lo + hi) >> 1;
    if (sorted[m] < t) lo = m + 1;
    else hi = m;
  }
  return (lo < sorted.length && sorted[lo] - t < d) || (lo > 0 && t - sorted[lo - 1] < d);
}

/** Where time t (ms on the SVG's timeline, from 0, as it plays on) is in the cycle: past the intro it wraps in the period */
export function phaseOf(f: SvgFrames, t: number): number {
  if (t < f.intro + f.period) return Math.max(0, t);
  return f.period ? f.intro + ((t - f.intro) % f.period) : f.intro;
}
/** The frame shown at cycle time t: the last one started (before the first, the last frame: the cycle wrapped into it) */
export function frameAt(f: SvgFrames, t: number): number {
  if (t < f.starts[0] - 1e-6) return f.starts.length - 1;
  let lo = 0,
    hi = f.starts.length - 1;
  while (lo < hi) {
    const m = (lo + hi + 1) >> 1;
    if (f.starts[m] <= t + 1e-6) lo = m;
    else hi = m - 1;
  }
  return lo;
}

// ---------- reading the timelines ----------
/** Where steps(n, …) / step-start / step-end jump, in fractions of the interval it eases; null for an easing that is not stepped */
function stepJumps(easing: string | undefined): number[] | null {
  const e = (easing ?? "").trim();
  const m = /^steps\(\s*(\d+)\s*(?:,\s*([a-z-]+)\s*)?\)$/.exec(e);
  const n = e === "step-start" || e === "step-end" ? 1 : m ? Math.max(1, Number(m[1])) : 0;
  if (!n) return null;
  const pos = e === "step-start" ? "start" : (m?.[2] ?? "end");
  const from = pos === "start" || pos === "jump-start" || pos === "jump-both" ? 0 : 1,
    to = pos === "start" || pos === "jump-start" || pos === "jump-none" ? n - 1 : n;
  return Array.from({ length: Math.max(0, to - from + 1) }, (_, j) => (from + j) / n);
}
/** The jumps and ramps of a run of keyframes (offsets 0..1, ascending), with the easing of each interval (on its first keyframe)
 *  and whether the interval changes anything; `whole`: the effect's own easing, over the whole iteration */
function keyframeChanges(
  offsets: number[],
  easings: (string | undefined)[],
  moves: boolean[],
  whole?: string,
): Pick<Track, "jumps" | "ramps"> {
  const jumps: number[] = [];
  const ramps: [number, number][] = [];
  const all = stepJumps(whole);
  for (let i = 0; i + 1 < offsets.length; i++) {
    const a = offsets[i],
      b = offsets[i + 1];
    if (!moves[i]) continue;
    // stepped over the whole iteration: what changes in this interval changes on the steps in it
    if (all) for (const j of all) j > a && j <= b && jumps.push(j);
    if (all) continue;
    const st = b > a ? stepJumps(easings[i]) : null;
    if (st) for (const j of st) jumps.push(a + (b - a) * j);
    else if (b > a) ramps.push([a, b]);
    else jumps.push(a);
  }
  return { jumps, ramps };
}

/** What cssTrack reads of an Animation */
export type AnimationLike = {
  effect: {
    getComputedTiming(): ComputedEffectTiming;
    /** A KeyframeEffect's; any other effect has none to read */
    getKeyframes?(): ComputedKeyframe[];
  } | null;
};
const KF_META = new Set(["offset", "computedOffset", "easing", "composite"]);
/** A CSS animation's (or any Web Animation's) timeline */
export function cssTrack(a: AnimationLike): Track | null {
  const e = a.effect;
  if (!e) return null;
  const t = e.getComputedTiming();
  const dur = typeof t.duration === "number" ? t.duration : Number(t.duration);
  if (!Number.isFinite(dur)) return null;
  const kf = e.getKeyframes?.() ?? [];
  const offsets = kf.map((k, i) => Number(k.computedOffset ?? k.offset ?? (kf.length > 1 ? i / (kf.length - 1) : 0)));
  const vals = kf.map((k) =>
    Object.keys(k)
      .filter((p) => !KF_META.has(p))
      .sort()
      .map((p) => `${p}:${String(k[p])}`)
      .join(";"),
  );
  const moves = kf.map((_, i) => i + 1 < kf.length && vals[i] !== vals[i + 1]);
  const dir = t.direction ?? "normal";
  const alternate = dir.startsWith("alternate");
  const { jumps, ramps } = keyframeChanges(
    offsets,
    kf.map((k) => k.easing),
    moves,
    t.easing,
  );
  // an iteration that ends on another value than the next one starts with
  if (!alternate && kf.length && vals[0] !== vals[vals.length - 1]) jumps.push(0);
  return {
    dur,
    delay: Number(t.delay) || 0,
    iterations: t.iterations === Infinity ? Infinity : Number(t.iterations ?? 1),
    alternate,
    reverse: dir.endsWith("reverse"),
    jumps,
    ramps,
    dropsAtEnd: t.fill !== "forwards" && t.fill !== "both",
  };
}

/** Times in a SMIL begin list ("0s; 2s", 0 when there is none): the plain (signed) clock values; syncbase and event values are not
 *  followed, and an element begun only by those has no timeline here */
function beginsOf(v: string | null): number[] {
  if (!v?.trim()) return [0];
  return v
    .split(";")
    .map((s) => s.trim())
    .map((s) => (s[0] === "-" ? -clockMs(s.slice(1)) : clockMs(s.replace(/^\+/, ""))))
    .filter(Number.isFinite);
}
/** A SMIL animation element's timelines (one per begin time) */
export function smilTracks(el: Element): Track[] {
  const attr = (n: string) => el.getAttribute(n);
  const begins = beginsOf(attr("begin"));
  const dur = clockMs(attr("dur"));
  const drops = attr("fill") !== "freeze";
  if (el.localName === "set") {
    const d = Number.isFinite(dur) ? dur : 0;
    return begins.map((delay) => ({ dur: d, delay, iterations: 1, jumps: [0], ramps: [], dropsAtEnd: d > 0 && drops }));
  }
  if (!(dur >= MIN_DUR)) return [];
  const rc = attr("repeatCount")?.trim(),
    rd = clockMs(attr("repeatDur"));
  const iterations =
    rc === "indefinite" || attr("repeatDur")?.trim() === "indefinite"
      ? Infinity
      : Number(rc) > 0
        ? Number(rc)
        : rd > 0
          ? rd / dur
          : 1;
  const values = attr("values")
    ?.split(";")
    .map((s) => s.trim());
  if (values && !values[values.length - 1]) values.pop();
  const discrete = attr("calcMode") === "discrete";
  // from / to / by: two values (a by alone moves from where it is)
  const vals = values?.length ? values : [attr("from") ?? "", attr("to") ?? attr("by") ?? "~"];
  const n = vals.length;
  const kt = attr("keyTimes")
    ?.split(";")
    .map((s) => Number(s.trim()))
    .filter((x) => Number.isFinite(x));
  const times =
    kt && kt.length === n ? kt : Array.from({ length: n }, (_, i) => (discrete ? i / n : n > 1 ? i / (n - 1) : 0));
  const jumps: number[] = [];
  const ramps: [number, number][] = [];
  if (vals[0] !== vals[n - 1]) jumps.push(0);
  if (discrete) for (let i = 1; i < n; i++) vals[i] !== vals[i - 1] && jumps.push(times[i]);
  else if (el.localName === "animateMotion" && !values?.length) ramps.push([0, 1]);
  else
    for (let i = 0; i + 1 < n; i++)
      if (vals[i] !== vals[i + 1])
        times[i + 1] > times[i] ? ramps.push([times[i], times[i + 1]]) : jumps.push(times[i]);
  return begins.map((delay) => ({ dur, delay, iterations, jumps, ramps, dropsAtEnd: drops }));
}
