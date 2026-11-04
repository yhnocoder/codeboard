// The zoom diagnostics log (the host's Record Zoom Log command, HostToBoard "zoomLog"): run once it starts recording on this board,
// run again it stops and hands the log back. Off it costs nothing: no frame loop, no observer, no listener; the board's hooks
// (lodcards.ts, cull.ts, summary.ts) check zlogging() before they build a line. Recording stops by itself after LIMIT ms and
// keeps what it recorded until it is asked for.
//
// One line per animation frame: `f <t> <dt> z<scale> [w<n>|p<n> <latency>]`: t ms since the start, dt the frame's delta, the
// camera scale, the wheel (w: pan or scroll) and pinch / ctrl+wheel (p: zoom) events that arrived since the frame before, and the
// time from the first of them to this frame's start. Events between frames: `L <t> <ms>` a long task, `D …` cards switched to a
// detail level (lodcards.ts), `C …` cards shown, hidden, painted again or not painted (cull.ts), `S …` the cross-fade between the
// card and summary levels starting and ending, `B <t> <ms>` the summary layer built.
import { cam } from "./camera";
import { placed, state } from "./store";

const LIMIT = 30_000;

type Rec = {
  t0: number;
  lines: string[];
  raf: number;
  last: number;
  wheels: number;
  pinches: number;
  first: number;
  done: boolean;
  stop: () => void;
};
let rec: Rec | null = null;

const ms = (n: number) => n.toFixed(1);
/** Recording now: the hooks build their lines only then */
export const zlogging = () => rec !== null && !rec.done;
/** One line of the log, stamped with the time since the start */
export function zlog(kind: string, text: string) {
  if (rec && !rec.done) rec.lines.push(`${kind} ${ms(performance.now() - rec.t0)} ${text}`);
}

function start(): Rec {
  const s = state.host.settings;
  const r: Rec = {
    t0: performance.now(),
    lines: [
      `# CodeBoard zoom log ${new Date().toISOString()}`,
      `# cores ${navigator.hardwareConcurrency} dpr ${devicePixelRatio} view ${innerWidth}x${innerHeight} cards ${placed().length} z ${cam.z.toFixed(4)} overview<${s.zoomOverview} map<${s.zoomMap}`,
      `# ${navigator.userAgent}`,
      "# f t dt z [w|p<events> latency]; L long task; D detail level; C cull; S fade; B summary build (ms)",
    ],
    raf: 0,
    last: 0,
    wheels: 0,
    pinches: 0,
    first: 0,
    done: false,
    stop: () => {},
  };
  const wheel = (e: WheelEvent) => {
    if (!r.wheels && !r.pinches) r.first = e.timeStamp;
    if (e.ctrlKey) r.pinches++;
    else r.wheels++;
  };
  addEventListener("wheel", wheel, { capture: true, passive: true });
  let obs: PerformanceObserver | undefined;
  try {
    obs = new PerformanceObserver((l) => {
      for (const e of l.getEntries()) r.lines.push(`L ${ms(e.startTime - r.t0)} ${ms(e.duration)}`);
    });
    obs.observe({ type: "longtask" });
  } catch {
    r.lines.push("# long tasks are not reported here");
  }
  const frame = (t: number) => {
    const at = t - r.t0;
    let l = `f ${ms(at)} ${r.last ? ms(t - r.last) : "-"} z${cam.z.toFixed(4)}`;
    if (r.wheels || r.pinches)
      l += ` ${r.pinches ? `p${r.pinches}` : ""}${r.wheels ? `w${r.wheels}` : ""} ${ms(t - r.first)}`;
    r.lines.push(l);
    r.last = t;
    r.wheels = r.pinches = 0;
    if (at >= LIMIT) {
      r.lines.push(`# stopped after ${LIMIT / 1000} s`);
      r.stop();
    } else r.raf = requestAnimationFrame(frame);
  };
  r.raf = requestAnimationFrame(frame);
  r.stop = () => {
    r.done = true;
    cancelAnimationFrame(r.raf);
    removeEventListener("wheel", wheel, { capture: true });
    obs?.disconnect();
  };
  return r;
}

/** Starts recording (null), or stops and returns the log */
export function toggleZoomLog(): string | null {
  if (!rec) {
    rec = start();
    return null;
  }
  const r = rec;
  rec = null;
  r.stop();
  return r.lines.join("\n");
}
