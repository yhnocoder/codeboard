// Zoomed-out summaries (state/summary.ts, canvas/Summaries.tsx): the user's edit, ↻ and 保留. The rules are core commands
import { summaryRequest, type SumKey } from "@codeboard/core";
import * as C from "@codeboard/core/commands";
import { state } from "../state/store";
import { boardSignal } from "../state/root";
import { summaryLayout } from "../state/summary";
import { commandEnv } from "./env";
import { aiFailed } from "./imageai";

/** The items whose ↻ is waiting for the host */
const [writing, setWriting] = boardSignal<ReadonlySet<string>>(new Set());
export const summaryWriting = (key: string) => writing().has(key);

export const editSummary = (key: string, text: string) => C.editSummary(commandEnv, key, text);
/** 保留: the summary stays as it is and is no longer pending (no rewrite for the changes so far) */
export const keepSummary = (key: string) => C.keepSummary(commandEnv, key);

/** ↻: the host writes the item's summary now, sized by its column; a hand edit is replaced. Failures show as the AI tools' do */
export async function regenerateSummary(key: SumKey) {
  const layout = summaryLayout();
  const input = layout && summaryRequest(state.board, key, layout);
  if (!input || writing().has(key)) return;
  const board = state.board.id;
  setWriting((s) => new Set(s).add(key));
  try {
    const r = await C.regenerateSummary(commandEnv, input).catch(
      (e): Awaited<ReturnType<typeof C.regenerateSummary>> => ({ fail: "http", message: (e as Error).message }),
    );
    if (r && state.board.id === board) aiFailed(r);
  } finally {
    setWriting((s) => {
      const n = new Set(s);
      n.delete(key);
      return n;
    });
  }
}
