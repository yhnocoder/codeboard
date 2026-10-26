// Waits for the VS Code e2e scripts (drive, replay, projects, release-shots, review-keys): wait for real state, never for a fixed time.
//   until(what, f, ms)   poll f until it returns something truthy (and return it); throw `until: <what>: not within <ms> ms` otherwise
//   idle(frame)          the board in that webview frame has settled: no request waiting on the host, camera at rest, no animation,
//                        fonts loaded, no DOM change for a moment. Needs track(page) before the board's webview was created
//   hold(ms, why)        a wait that has to be a fixed time (something must NOT happen before a timer; a gesture's rhythm). The only
//                        fixed wait allowed in these scripts: packages/board/test/unit/scenario-waits.test.ts checks that, and counts them
//   timing               the board's named delays (packages/board/src/state/timing.ts), the same numbers the product uses
// Same rules as the harness scenarios (packages/board/test/fixtures.ts)
const path = require("path");

const tick = (ms) => new Promise((r) => setTimeout(r, ms)); // the poll step of until / idle, never a wait of its own
const show = (v) => { try { return JSON.stringify(v)?.slice(0, 200); } catch { return String(v); } };

/** Poll f every `step` ms until it returns something truthy and return that. An error thrown by f counts as "not yet" (a frame that
 *  is being replaced, an element not there yet); on timeout the last value or error is in the message */
async function until(what, f, ms = 10000, step = 50) {
  let last;
  for (const end = Date.now() + ms; ;) {
    try { const v = await f(); if (v) return v; last = v; } catch (e) { last = `error: ${String(e?.message ?? e).split("\n")[0]}`; }
    if (Date.now() >= end) throw new Error(`until: ${what}: not within ${ms} ms (last: ${show(last)})`);
    await tick(step);
  }
}

/** Poll f until ok(value) holds and return the value; on timeout return the last value. For a value that a check then judges: the
 *  check's own message says what was expected, so a timeout fails that check rather than the whole run */
async function soon(f, ok = Boolean, ms = 10000, step = 50) {
  let v;
  for (const end = Date.now() + ms; ;) {
    try { v = await f(); if (ok(v)) return v; } catch (e) { v = undefined; }
    if (Date.now() >= end) return v;
    await tick(step);
  }
}

let holds = 0;
/** A fixed wait: only where the step checks that something does not happen before a timer, or a gesture needs its rhythm. ms comes from
 *  `timing` (or a constant named where it is used) and why says what must not happen meanwhile */
async function hold(ms, why) {
  if (!(ms >= 0) || typeof why !== "string" || !why.trim()) throw new Error(`hold(${ms}, ${show(why)}): needs a time and a reason`);
  holds++;
  if (process.env.HOLD_DEBUG) console.log(`  · hold ${ms} ms: ${why}`);
  await tick(ms);
}
hold.count = () => holds;

/** The exports of a source file of the repo (path from the repo root), compiled on the fly: product constants the checks compare with */
function fromSource(rel) {
  const { outputFiles } = require("esbuild").buildSync({ entryPoints: [path.join(__dirname, "../../..", rel)], bundle: true, platform: "node", format: "cjs", write: false, logLevel: "silent" });
  const m = { exports: {} };
  new Function("module", "exports", "require", outputFiles[0].text)(m, m.exports, require);
  return m.exports;
}
/** The board's named delays, compiled from the board's own source on first use */
let T = null;
const timing = new Proxy({}, { get(_, k) {
  T ??= fromSource("packages/board/src/state/timing.ts");
  if (typeof k === "string" && !(k in T)) throw new Error(`timing.${k}: no such constant in packages/board/src/state/timing.ts`);
  return T[k];
} });

// ---------- requests waiting on the host ----------
// The board asks the host with { type, req } and the host answers { type: "reply", req } (packages/board/src/host.ts). A board webview
// is two frames: VS Code's host page (webview/browser/pre/index.html) and, inside it, the board. The board's acquireVsCodeApi() posts
// through the host page's window.__vscode_post_message__, and replies come into the host page through a MessagePort before it hands
// them to the board. Both are wrapped in the host page before its own scripts run (an init script), so window.__e2eAsks there holds
// the requests not answered yet. The board's own frame can't be instrumented this way: VS Code writes it with document.write.
// Requests that wait on the user (a confirmation, a file dialog: WAITS_ON_USER in host.ts) are not counted
const ON_USER = ["confirm", "pickFile", "exportFile", "deleteEverywhere", "deleteBoard", "newBoard", "gh", "github"];
function trackAsks(skip) {
  if (!location.protocol.startsWith("vscode-webview") || !/\/index\.html$/.test(location.pathname)) return;
  try {
    const asks = new Map(), sent = {};
    window.__e2eAsks = asks; window.__e2eSent = sent;
    let post;
    Object.defineProperty(window, "__vscode_post_message__", { configurable: true, get: () => post, set(fn) {
      post = (command, data) => {
        const m = data?.message;
        if (command === "onmessage" && typeof m?.type === "string") sent[m.type] = (sent[m.type] ?? 0) + 1;
        if (command === "onmessage" && m && typeof m.req === "number" && !skip.includes(m.type)) asks.set(m.req, m.type);
        return fn(command, data);
      };
    } });
    const d = Object.getOwnPropertyDescriptor(MessagePort.prototype, "onmessage");
    Object.defineProperty(MessagePort.prototype, "onmessage", { configurable: true, get() { return d.get.call(this); }, set(fn) {
      d.set.call(this, typeof fn !== "function" ? fn : function (e) {
        const m = e.data?.args?.message;
        if (e.data?.channel === "message" && m?.type === "reply") asks.delete(m.req);
        return fn.call(this, e);
      });
    } });
  } catch (e) { window.__e2eTrackError = String(e); }
}
/** Track the board's requests in every webview this window opens from now on (call before the first board opens) */
const track = (page) => page.addInitScript(trackAsks, ON_USER);
/** The board's requests not answered yet (their types), read from its host page */
async function waiting(fr) {
  const host = fr.parentFrame();
  const r = host && await host.evaluate(() => window.__e2eTrackError ? { err: window.__e2eTrackError } : window.__e2eAsks && [...window.__e2eAsks.values()]);
  if (r?.err) throw new Error(`the board's requests could not be tracked: ${r.err}`);
  if (!r) throw new Error("this webview's requests are not tracked (call track(page) before the board opens)");
  return r;
}

/** How many messages of this type the board in fr has sent to the host so far (e.g. "patch": its saved changes) */
const sent = async (fr, type) => (await fr.parentFrame().evaluate((t) => window.__e2eSent?.[t] ?? 0, type));

// ---------- the board has settled ----------
// Sampled from here (timers in a webview may be throttled, and a hidden webview paints no frames): what is busy, plus a key of the
// camera transform and a count of DOM mutations (cards measured, code highlighted, a host push shown). Settled once nothing is busy and
// the key has not changed for `quiet` ms
function sample() {
  const w = window;
  if (!w.__e2eMuts) {
    w.__e2eMuts = { n: 0 };
    new MutationObserver((l) => { w.__e2eMuts.n += l.length; }).observe(document.documentElement, { subtree: true, childList: true, attributes: true, characterData: true });
  }
  const world = document.querySelector(".world");
  const anims = document.getAnimations().filter((a) => a.playState === "running" && Number.isFinite(a.effect?.getComputedTiming().endTime));
  const busy = [
    document.fonts.status !== "loaded" && "fonts loading",
    world?.matches(".moving, .settle") && "camera moving",
    anims.length > 0 && `animations: ${anims.map((a) => a.transitionProperty ?? a.animationName ?? "?").join(", ")}`,
  ].filter(Boolean);
  return { busy, key: `${world ? getComputedStyle(world).transform : ""}|${w.__e2eMuts.n}` };
}
/** The board in frame fr has settled (see the top of this file). host: false for a board without a host (an exported snapshot) */
async function idle(fr, { ms = 15000, quiet = 300, host = true } = {}) {
  const t0 = Date.now();
  let last = null, since = t0, why = "";
  for (;;) {
    let s;
    try {
      s = await fr.evaluate(sample);
      const asks = host ? await waiting(fr) : [];
      if (asks.length) s.busy.unshift(`${asks.length} request(s) waiting on the host: ${asks.join(", ")}`);
    } catch (e) { throw new Error(`idle: ${String(e.message).split("\n")[0]}`); }
    const now = Date.now();
    if (s.busy.length || !last || s.key !== last.key) { since = now; why = s.busy.join("; ") || "the board is changing"; }
    else if (now - since >= quiet) break;
    last = s;
    if (now - t0 > ms) throw new Error(`idle: the board did not settle within ${ms} ms (${why})`);
    await tick(40);
  }
  if (process.env.IDLE_DEBUG && Date.now() - t0 > 1500) console.log(`  · idle ${Date.now() - t0} ms ${new Error().stack.split("\n")[2].trim()}`);
}

module.exports = { until, soon, hold, idle, track, waiting, sent, timing, fromSource };
