// The host's side of code highlighting: core's highlighter and segment views, reading the file at the segment's version,
// the analysis cache and the call packages from this workspace.
import { Highlighter, plainView, segViewOf, type SegSource } from "@codeboard/core/highlight";
import type { Segment, SegView, Tok } from "@codeboard/core";
import { highlightLines } from "@codeboard/analysis";
import { analysisOf, analysisReady, segAnalysis, whenAnalysisReady } from "./analysis";
import { absOf, versionText } from "./source";
import { callPkgs } from "./scope";
import { readText } from "./ws";

const hl = new Highlighter({
  // While the host is still starting and the grammars load, wait for them: the cache should not keep an uncoloured copy
  async treeLines(g, text, file) {
    await whenAnalysisReady();
    return analysisReady() ? highlightLines(g, text, file) : null;
  },
});

const source: SegSource = {
  fileText: (seg) => versionText(seg),
  currentText: (seg) => { const abs = absOf(seg); return abs ? readText(abs) : Promise.resolve(null); },
  fileOf: (seg) => absOf(seg),
  analyze: (lang, text, range, file) => (range ? segAnalysis(lang, text, range.start, range.end, file) : analysisOf(lang, text, file)),
  callPkgs,
};

/** Tokens per line (with the board's colour classes); file = text is that file's whole text at that version */
export const tokensOf = (lang: string, text: string, file?: string): Promise<Tok[][]> => hl.tokensOf(lang, text, file);
/** A few lines' HTML (diffs, hovered definitions, Focus popovers; no clickable calls) */
export const highlight = (lines: string[], lang: string, context?: string): Promise<string[]> => hl.highlight(lines, lang, context);
export const segView = (seg: Segment): Promise<SegView> => segViewOf(seg, source, hl);

/** A batch of segments' views (a segment that fails shows plain text, the rest of the board still works) */
export async function viewsFor(segs: Segment[]): Promise<Record<string, SegView>> {
  const out: Record<string, SegView> = {};
  await Promise.all(segs.map(async (s) => {
    try { out[s.id] = await segView(s); } catch (e) {
      console.error("[codeboard] view", s.path, e);
      out[s.id] = plainView(s);
    }
  }));
  return out;
}
