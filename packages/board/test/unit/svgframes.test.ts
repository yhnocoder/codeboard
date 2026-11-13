// @vitest-environment jsdom
// The frames an animated SVG without data-steps is stepped through (md/svgframes.ts): read from its CSS animations' timing and
// keyframes and its SMIL elements' attributes, over one cycle (LCM of the periods): the scenes between cuts, each stood on just
// before the next cut; a smooth loop with no scenes sampled at 12 fps
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import {
  cssTrack,
  frameAt,
  MAX_FRAMES,
  phaseOf,
  smilTracks,
  svgFrames,
  type AnimationLike,
  type Track,
} from "../../src/md/svgframes";

/** A CSS animation as getAnimations() gives it: its computed timing and keyframes */
const css = (dur: number, kf: [number, string, string?][], o: Partial<ComputedEffectTiming> = {}): AnimationLike => ({
  effect: {
    getComputedTiming: () => ({
      duration: dur,
      delay: 0,
      iterations: Infinity,
      direction: "normal",
      fill: "none",
      ...o,
    }),
    getKeyframes: () =>
      kf.map(([offset, transform, easing]) => ({
        offset,
        computedOffset: offset,
        easing: easing ?? "linear",
        transform,
      })),
  },
});
const framesOf = (ts: (Track | null)[]) => svgFrames(ts.filter((t): t is Track => !!t));
const startsOf = (ts: (Track | null)[]) => framesOf(ts)?.starts.map((t) => Math.round(t));
const smil = (markup: string) => {
  const doc = new DOMParser().parseFromString(
    `<svg xmlns="http://www.w3.org/2000/svg"><rect>${markup}</rect></svg>`,
    "image/svg+xml",
  );
  return [...doc.querySelectorAll("animate, set, animateTransform, animateMotion")].flatMap(smilTracks);
};
/** The CSS animations of an SVG whose rules are `@keyframes x{…} .x{animation:x <dur>s infinite}`, as a browser reads them:
 *  keyframes at one offset merged, the animation's easing (ease) on keyframes that set none */
function cssOf(svg: string): AnimationLike[] {
  const out: AnimationLike[] = [];
  for (const m of svg.matchAll(/@keyframes ([\w-]+)\{(.*?)\}\}\s*\.\1\{animation:\1 ([\d.]+)s infinite/g)) {
    const byOffset = new Map<number, Record<string, string>>();
    for (const k of m[2].matchAll(/([\d.]+)%\{([^}]*)/g)) {
      const o = Number(k[1]) / 100,
        kf = byOffset.get(o) ?? { easing: "ease" };
      for (const d of k[2].split(";")) {
        const [p, v] = d.split(/:(.*)/s).map((x) => x.trim());
        if (p) kf[p === "animation-timing-function" ? "easing" : p] = v;
      }
      byOffset.set(o, kf);
    }
    const kfs = [...byOffset].sort((a, b) => a[0] - b[0]).map(([o, kf]) => ({ ...kf, offset: o, computedOffset: o }));
    const dur = Number(m[3]) * 1000;
    out.push({
      effect: {
        getComputedTiming: () => ({ duration: dur, delay: 0, iterations: Infinity, direction: "normal", fill: "none" }),
        getKeyframes: () => kfs,
      },
    });
  }
  return out;
}
const grid = (n: number, step: number) => Array.from({ length: n }, (_, i) => i * step);

describe("svgFrames", () => {
  it("steps a CSS steps(12) animation through its 12 steps", () => {
    const a = css(1200, [
      [0, "translateX(0px)", "steps(12, end)"],
      [1, "translateX(120px)"],
    ]);
    expect(startsOf([cssTrack(a)])).toEqual(grid(12, 100));
    expect(framesOf([cssTrack(a)])).toMatchObject({ intro: 0, period: 1200 });
  });

  it("stops on keyframes at 0 / 25 / 60 / 100%", () => {
    const kf = (e?: string): [number, string, string?][] => [
      [0, "a", e],
      [0.25, "b", e],
      [0.6, "c", e],
      [1, "d"],
    ];
    // held between keyframes: exactly the keyframes (100% is the next cycle's 0)
    expect(startsOf([cssTrack(css(1000, kf("step-end")))])).toEqual([0, 250, 600]);
    // interpolated: the keyframes, and 12 fps samples in between where no keyframe is close
    const smooth = startsOf([cssTrack(css(1000, kf()))])!;
    expect(smooth).toEqual(expect.arrayContaining([0, 250, 600]));
    expect(smooth).toEqual([0, 83, 167, 250, 333, 417, 500, 600, 667, 750, 833, 917]);
  });

  it("a change over less than 100 ms is a cut: the scenes between, stood on just before the next cut", () => {
    const blink = css(1000, [
      [0, "a"],
      [0.49, "a"],
      [0.5, "b"],
      [1, "b"],
    ]);
    expect(framesOf([cssTrack(blink)])).toMatchObject({ starts: [0, 500], stands: [489.5, 999.5] });
  });

  it("an animation's own steps() easing steps the whole iteration", () => {
    const a = css(
      800,
      [
        [0, "a"],
        [1, "b"],
      ],
      { easing: "steps(4)" },
    );
    expect(startsOf([cssTrack(a)])).toEqual([0, 200, 400, 600]);
  });

  it("an alternating animation's cycle is two iterations, the second backwards", () => {
    const a = css(
      1000,
      [
        [0, "a", "step-end"],
        [0.3, "b", "step-end"],
        [1, "c"],
      ],
      { direction: "alternate" },
    );
    expect(framesOf([cssTrack(a)])).toMatchObject({ period: 2000, starts: [300, 1000, 1700] });
  });

  it("reads SMIL keyTimes with 5 values", () => {
    const t = smil(
      '<animate attributeName="x" values="0;10;20;30;40" keyTimes="0;0.25;0.5;0.75;0.9" calcMode="discrete" dur="2s" repeatCount="indefinite"/>',
    );
    expect(startsOf(t)).toEqual([0, 500, 1000, 1500, 1800]);
    // linear between them: the keyTimes and samples in between
    const lin = startsOf(
      smil(
        '<animate attributeName="x" values="0;10;20;30;40" keyTimes="0;0.1;0.3;0.6;1" dur="1s" repeatCount="indefinite"/>',
      ),
    )!;
    expect(lin).toEqual([0, 100, 167, 250, 300, 333, 417, 500, 600, 667, 750, 833, 917]);
  });

  it("reads calcMode discrete without keyTimes as even steps", () => {
    const t = smil(
      '<animate attributeName="fill" values="red;green;blue;black" calcMode="discrete" dur="2s" repeatCount="indefinite"/>',
    );
    expect(startsOf(t)).toEqual([0, 500, 1000, 1500]);
  });

  it("steps through a <set> sequence, ending on its last pose", () => {
    const t = smil(
      ["0s", "1s", "2s", "3s"]
        .map((b, i) => `<set attributeName="x" to="${i * 10}" begin="${b}" fill="freeze"/>`)
        .join(""),
    );
    expect(framesOf(t)).toEqual({
      starts: [0, 1000, 2000, 3000],
      stands: [999.5, 1999.5, 2999.5, 3000.5],
      intro: 3000,
      period: 0,
    });
    // a begin it cannot resolve (another element's end) leaves that one out
    expect(smil('<set attributeName="x" to="1" begin="a.end"/>')).toEqual([]);
  });

  it("merges mixed durations over their LCM", () => {
    const four = css(1000, [
      [0, "a", "steps(4)"],
      [1, "b"],
    ]);
    const three = css(1200, [
      [0, "a", "steps(3)"],
      [1, "b"],
    ]);
    const f = framesOf([cssTrack(four), cssTrack(three)])!;
    expect(f.period).toBe(6000);
    // 24 quarter seconds and 15 steps of 400 ms, 0 / 2000 / 4000 shared
    expect(f.starts.length).toBe(36);
    expect(f.starts.map(Math.round)).toEqual([...new Set([...grid(24, 250), ...grid(15, 400)])].sort((a, b) => a - b));
  });

  it("falls back to the longest period when the LCM explodes", () => {
    const step = (d: number) =>
      cssTrack(
        css(d, [
          [0, "a", "step-end"],
          [1, "b"],
        ]),
      );
    expect(framesOf([step(1001), step(1013)])?.period).toBe(1013);
  });

  it("samples a smooth-only 2 s animation at 12 fps: 24 frames", () => {
    const a = css(2000, [
      [0, "rotate(0deg)"],
      [1, "rotate(360deg)"],
    ]);
    const f = framesOf([cssTrack(a)])!;
    expect(f.starts.length).toBe(24);
    expect(f.starts.map(Math.round)).toEqual(grid(24, 1000 / 12).map(Math.round));
  });

  it("a delayed start and a one-off animation come before the repeating part", () => {
    const spin = css(
      1000,
      [
        [0, "a", "steps(2)"],
        [1, "b"],
      ],
      { delay: 500 },
    );
    const once = css(
      700,
      [
        [0, "a", "step-end"],
        [1, "b"],
      ],
      { iterations: 1, fill: "none" },
    );
    const f = framesOf([cssTrack(spin), cssTrack(once)])!;
    expect(f).toMatchObject({ intro: 700, period: 1000 });
    expect(f.starts.map(Math.round)).toEqual([0, 500, 700, 1000, 1500]);
    expect(phaseOf(f, 1700)).toBe(700);
    // 2950 ms in: the spinner (from 500) is as far into its step as at 950
    expect(phaseOf(f, 2950)).toBe(950);
    expect(frameAt(f, phaseOf(f, 2950))).toBe(2);
    // a negative delay is a phase: it starts that far in
    const late = css(
      1000,
      [
        [0, "a", "steps(4)"],
        [1, "b"],
      ],
      { delay: -100 },
    );
    // and time 0 is in the last step, which the cycle wraps into
    const lf = framesOf([cssTrack(late)])!;
    expect(lf.starts.map(Math.round)).toEqual([150, 400, 650, 900]);
    expect(frameAt(lf, 0)).toBe(3);
  });

  it("caps the frames at MAX_FRAMES, the same ones every time", () => {
    const fine = css(20000, [
      [0, "a", "steps(1000)"],
      [1, "b"],
    ]);
    const a = framesOf([cssTrack(fine)])!,
      b = framesOf([cssTrack(fine)])!;
    expect(a.starts.length).toBe(MAX_FRAMES);
    expect(a).toEqual(b);
    expect(a.starts[0]).toBe(0);
  });

  it("steps a diagram of 16 scenes cut in by opacity through its 16 scenes, moves inside a scene settled", () => {
    const scenes = () => cssOf(fs.readFileSync(path.join(__dirname, "../svg/scenes-16.svg"), "utf8")).map(cssTrack);
    const f = framesOf(scenes())!;
    expect(f.period).toBe(33200);
    expect(f.starts.length).toBe(16);
    // each scene starts when its cut (20 ms of opacity) has ended
    expect(f.starts.slice(0, 4).map((t) => Math.round((t / 33200) * 100000) / 1000)).toEqual([
      0, 8.434, 12.048, 15.361,
    ]);
    // scene 3 (s2) moves its tiles from 12.048% to 15.301% (ease-in-out): it is stood on once they have arrived, before the cut
    expect(f.stands[2]).toBeCloseTo(0.15301 * 33200 - 0.5, 3);
    expect(f.stands[2]).toBeGreaterThan(f.starts[2]);
    expect(framesOf(scenes())).toEqual(f);
  });

  it("finds nothing to step in no animation", () => {
    expect(svgFrames([])).toBeNull();
  });
});
