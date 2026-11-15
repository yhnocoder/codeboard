// Tidy Up's layout (@codeboard/core/tidy, with ELK), on its own for the app's hidden tidy web view (CodeBoardNotes
// Tidy.swift): tidyUp(rects, links, fixed, avoid) gives each rect's new top left
import { tidy } from "@codeboard/core/tidy";

type R = { id: string; x: number; y: number; w: number; h: number };
// ELK's GWT code looks for `global`
(globalThis as { global?: unknown }).global = globalThis;
(globalThis as { tidyUp?: unknown }).tidyUp = async (a: { cards: R[]; links: [string, string][]; fixed: R[]; avoid: R[] }) =>
  Object.fromEntries(await tidy(a.cards, a.links, a.fixed, a.avoid));
