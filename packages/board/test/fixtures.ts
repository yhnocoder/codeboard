// Playwright Test fixtures for the harness scenarios (scenarios/*.spec.ts):
//   open(o)          the board page in a new context of the worker's browser, with Node as its host (harness.ts); the test's
//                    boards are closed when it ends
//   check(name, ok)  a named check: a failed one fails the test at its end (expect.soft) and the test goes on; a check listed
//                    under "known" in tiers.json is reported as an annotation instead and doesn't fail the test
//   verdict(name, f) runs f(res), which fills res and returns whether it passed: check(name, ok, res). An f that makes its own
//                    checks returns undefined. If f throws, res goes into the error.
// Coverage (HARNESS_COV=1, nightly): the source files each test runs, attached to its result as "coverage" (tools/test/harness.mjs reads it).
import { test as base, expect, type Browser } from "@playwright/test";
import { ready, openBoard, idle, type Host, type OpenOptions, type PageCoverage } from "./harness";
import { nodeCoverage, pageFiles } from "./coverage";
import tiers from "./tiers.json";

export { expect };
export type { Host };

const COV = !!process.env.HARNESS_COV;
/** The dark theme unless HARNESS_LIGHT=1 */
export const light = !!process.env.HARNESS_LIGHT;

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const knownOf = (line: string) => Object.keys(tiers.known ?? {}).find((k) => new RegExp(`^${esc(k)}\\b`).test(line));

export function check(name: string, ok: unknown, ...detail: unknown[]) {
  const line = [name, ...detail.map((d) => (typeof d === "string" ? d : JSON.stringify(d)))].join(" ");
  if (ok) { console.log("PASS", line.slice(0, 1000)); return; }
  const k = knownOf(line);
  if (k) { test.info().annotations.push({ type: "known", description: line.slice(0, 400) }); console.log("FAIL (known)", line); return; }
  expect.soft(ok, line.slice(0, 3000)).toBeTruthy();
}

export async function verdict(name: string, f: (res: Record<string, unknown>) => Promise<unknown>) {
  const res: Record<string, unknown> = {};
  let ok: unknown;
  try { ok = await f(res); } catch (e) { if (e instanceof Error) e.message += `\n${name} ${JSON.stringify(res)}`; throw e; }
  if (ok !== undefined) check(name, ok, JSON.stringify(res));
}

// ---------- Waiting for real state, not for a fixed time ----------
//   until(h, what, f)   polls f (Node side: h.board(), h.sent, a store, a locator count…) until it returns something truthy and
//                       returns it; throws after ms, naming what it waited for and the last value
//   idle(h)             the board has settled: host replied to everything, camera at rest, no animation, cards still (harness.ts)
//   hold(h, ms, why)    a fixed wait that has to be one: a check that something does NOT happen within a product delay (pass
//                       the constant from src/state/timing.ts), a hover delay, a measurement. Never to let the board catch up
export { idle };

export async function until<T>(h: Host, what: string, f: () => T | Promise<T>, ms = 5000): Promise<NonNullable<T>> {
  const end = Date.now() + ms;
  let last: T;
  for (;;) {
    last = await f();
    if (last) return last as NonNullable<T>;
    if (Date.now() > end || h.page.isClosed()) break;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`until: ${what}: not within ${ms} ms (last: ${JSON.stringify(last)?.slice(0, 300)})`);
}

export const hold = (h: Host, ms: number, _why: string) => h.page.waitForTimeout(ms);

/** The running test's browser and boards */
let cur: { browser: Browser; hosts: Host[]; coverage?: PageCoverage } | undefined;

export async function open(o: OpenOptions = {}): Promise<Host> {
  if (!cur) throw new Error("open() is for a running test");
  const c = cur;
  const h = await openBoard(c.browser, o, { fail: (name, detail) => check(name, false, detail), coverage: c.coverage && ((e) => c.coverage!.push(...e)) });
  c.hosts.push(h);
  return h;
}

export const test = base.extend<{ boards: void }, { nodeCov: Awaited<ReturnType<typeof nodeCoverage>> | undefined }>({
  // once per worker: the analysis of nano-vllm, which every test's host reads
  nodeCov: [async ({}, use) => { const cov = COV ? await nodeCoverage() : undefined; await ready(); await use(cov); }, { scope: "worker" }],
  boards: [async ({ browser, nodeCov }, use, info) => {
    await nodeCov?.take(); // what ran before the test (loading the test files, the analysis of nano-vllm) belongs to no test
    cur = { browser, hosts: [], coverage: COV ? [] : undefined };
    await use();
    const c = cur;
    cur = undefined;
    for (const h of c.hosts) await h.close().catch(() => {});
    if (COV) {
      const files = new Set<string>();
      pageFiles(c.coverage!, files);
      await nodeCov!.take(files);
      await info.attach("coverage", { body: JSON.stringify([...files].sort()), contentType: "application/json" });
    }
  }, { auto: true }],
});
