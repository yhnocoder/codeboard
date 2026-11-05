// The zoom diagnostics log (the host's Record Zoom Log command, HostToBoard "zoomLog"): run once it starts recording on this board,
// run again it stops and hands the log back. Off it costs nothing: no frame loop, no observer, no listener; the board's hooks
// (cull.ts, summary.ts) check zlogging() before they build a line. Recording stops by itself after LIMIT ms and
// keeps what it recorded until it is asked for.
//
// One line per animation frame: `f <t> <dt> z<scale> [c<opacity>] [w<n>|p<n> <latency>]`: t ms since the start, dt the frame's
// delta, the camera scale, the card level's opacity while it fades, the wheel (w: pan or scroll) and pinch / ctrl+wheel (p: zoom)
// events that arrived since the frame before, and the time from the first of them to this frame's start. `X <t> <ids>` in a
// frame: cards in view drawn with their content hidden (cull.ts off, and not far), on a card level that shows: what a flicker
// looks like in the tree, if it is one. Events between frames: `L <t> <ms>` a long task, `C …` cards shown, hidden, painted again or not
// painted (cull.ts), `S …` the switch between the card and summary levels starting, swapping and ending, `W …` the faded card level
// kept drawn under the summaries or let go (summary.ts), `B <t> <ms>` the summary layer built.
import { cam } from "./camera";
import { placed } from "./store";

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

/** The ids of the cards in view drawn with their content hidden (cull.ts: off, and not far), on a card level that shows */
function blankInView(lay: HTMLElement): string {
  const ids: string[] = [];
  for (const c of lay.querySelectorAll<HTMLElement>(".card.off:not(.far)")) {
    const b = c.getBoundingClientRect();
    if (b.right > 0 && b.left < innerWidth && b.bottom > 0 && b.top < innerHeight) ids.push(c.dataset.id!);
  }
  return ids.join(" ");
}

function start(): Rec {
  const r: Rec = {
    t0: performance.now(),
    lines: [
      `# CodeBoard zoom log ${new Date().toISOString()}`,
      `# cores ${navigator.hardwareConcurrency} dpr ${devicePixelRatio} view ${innerWidth}x${innerHeight} cards ${placed().length} z ${cam.z.toFixed(4)}`,
      `# ${navigator.userAgent}`,
      "# f t dt z [c<card level opacity>] [w|p<events> latency]; X cards in view with no content; L long task; C cull; S fade; W faded card level kept drawn / let go; B summary build (ms)",
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
  let blank = "\0";
  const frame = (t: number) => {
    const at = t - r.t0;
    let l = `f ${ms(at)} ${r.last ? ms(t - r.last) : "-"} z${cam.z.toFixed(4)}`;
    const lay = document.querySelector<HTMLElement>(".cardlay");
    const o = lay ? +lay.style.opacity : 1;
    if (o > 0.01 && o < 1) l += ` c${o.toFixed(3)}`;
    if (r.wheels || r.pinches)
      l += ` ${r.pinches ? `p${r.pinches}` : ""}${r.wheels ? `w${r.wheels}` : ""} ${ms(t - r.first)}`;
    r.lines.push(l);
    // cards in view with their content hidden while the card level shows: none is expected; the line repeats only on a change
    const now = o > 0.05 && lay ? blankInView(lay) : "";
    if (now !== blank) r.lines.push(`X ${ms(at)} ${now || "none"}`);
    blank = now;
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
