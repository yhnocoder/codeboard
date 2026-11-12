// The host's side of code highlighting: the highlighter and segment views (highlight.ts), reading the file at the segment's version,
// the analysis cache and the call packages from this workspace.
import { Highlighter, plainView, segViewOf, type SegSource } from "./highlight";
import type { Segment, SegView, Tok } from "@codeboard/core";
import { highlightLines } from "@codeboard/analysis";
import { analysisOf, analysisReady, segAnalysis, treeAt, whenAnalysisReady } from "./analysis";
import { callPkgs } from "./scope";
import type { HostContext } from "./context";

const hl = new Highlighter({
  // While the host is still starting and the grammars load, wait for them: the cache should not keep an uncoloured copy
  async treeLines(g, text, tree) {
    await whenAnalysisReady();
    return analysisReady() ? highlightLines(g, text, tree) : null;
  },
});

/** Where a segment's file text comes from in this host */
const sourceOf = (cx: HostContext): SegSource => ({
  fileText: (seg) => cx.sources.versionText(seg),
  currentText: (seg) => {
    const abs = cx.sources.absOf(seg);
    return abs ? cx.readText(abs) : Promise.resolve(null);
  },
  fileOf: (seg) => cx.sources.absOf(seg),
  treeAt: (file) => treeAt(cx, file),
  analyze: (lang, text, range, tree) =>
    range ? segAnalysis(lang, text, range.start, range.end, tree) : analysisOf(lang, text, tree),
  callPkgs: (seg, imports, abs) => callPkgs(cx, seg, imports, abs),
});

/** Tokens per line (with the board's colour classes) */
export const tokensOf = (lang: string, text: string): Promise<Tok[][]> => hl.tokensOf(lang, text);
/** A few lines' HTML (diffs, hovered definitions, Focus popovers; no clickable calls) */
export const highlight = (lines: string[], lang: string, context?: string): Promise<string[]> =>
  hl.highlight(lines, lang, context);
export const segView = (cx: HostContext, seg: Segment): Promise<SegView> => segViewOf(seg, sourceOf(cx), hl);

/** A batch of segments' views (a segment that fails shows plain text, the rest of the board still works) */
export async function viewsFor(cx: HostContext, segs: Segment[]): Promise<Record<string, SegView>> {
  const out: Record<string, SegView> = {};
  await Promise.all(
    segs.map(async (s) => {
      try {
        out[s.id] = await segView(cx, s);
      } catch (e) {
        cx.log("error", `view ${s.path}: ${e instanceof Error ? (e.stack ?? e.message) : e}`);
        out[s.id] = plainView(s);
      }
    }),
  );
  return out;
}
