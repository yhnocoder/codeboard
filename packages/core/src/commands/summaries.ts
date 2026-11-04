// Zoomed-out summaries (summary.ts): the user's own text, ↻ (written now) and 保留 (kept as it is). All are undo steps. A hand edit is kept as a pair
// (the AI text it replaced, the user's), newest first, at most SUMMARY_PAIRS: rewrites, automatic or ↻, follow them and keep them.
import type { SummaryResult } from "../protocol";
import { putSummary, summaryInput, summaryOf, summaryPending, summarySig, type SumRequest } from "../summary";
import type { CommandEnv } from "./env";

/** How many of the user's edits a summary keeps */
const SUMMARY_PAIRS = 3;

/**
 * The user rewrote a summary (empty or unchanged: nothing). It is marked edited and counts as written from what is there now. The
 * edit is paired with the AI text it replaced; editing again before the next rewrite only updates that newest pair
 */
export function editSummary(env: CommandEnv, key: string, text: string) {
  const t = text.trim(),
    was = summaryOf(env.board(), key);
  if (!t || t === was?.text) return;
  env.edit((b) => {
    const s = summaryOf(b, key);
    const at = Date.now(),
      was = s?.pairs ?? [];
    const pairs =
      s?.edited && was.length
        ? [{ ...was[0], user: t, at }, ...was.slice(1)]
        : [{ ai: s?.text ?? "", user: t, at }, ...was].slice(0, SUMMARY_PAIRS);
    // written from what is there now: an edit alone never makes its summary pending or asks for a rewrite
    putSummary(b, key, {
      ...s,
      text: t,
      at,
      sig: summarySig(b, key) ?? "",
      input: summaryInput(b, key),
      edited: true,
      pairs,
    });
  });
}

/**
 * 保留: the summary stays as it is, counted as written from what is there now: no longer pending (its dot goes), so the host
 * neither waits to rewrite it nor asks on opening the board. Its text, edit mark and pairs are left alone. Undo makes it pending
 * again. Nothing written yet or not pending: nothing
 */
export function keepSummary(env: CommandEnv, key: string) {
  const b = env.board(),
    s = summaryOf(b, key);
  if (!s || !summaryPending(b, key)) return;
  env.edit((b) => {
    const s = summaryOf(b, key);
    if (s) putSummary(b, key, { ...s, sig: summarySig(b, key) ?? "", input: summaryInput(b, key) });
  });
}

/** ↻: the host writes the summary now, in the style of the user's edit if there is one. The failure, for the board to show */
export async function regenerateSummary(
  env: CommandEnv,
  input: SumRequest,
): Promise<Extract<SummaryResult, { fail: unknown }> | null> {
  const r = await env.ask("summarize", { input });
  if ("fail" in r) return r;
  env.edit((b) => void putSummary(b, input.key, r.summary));
  return null;
}
