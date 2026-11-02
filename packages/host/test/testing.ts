// @codeboard/host/testing: what the board's scenarios, harness and Storybook data use of the host beyond startHost (the
// "@codeboard/host" entry). The harness's real host (packages/board/test/realhost.ts) builds on startHost with the Node Workspace;
// the rest are pieces some scenarios call directly: test images, cards made as Add Function makes them, highlighting, the image
// and AI helpers a scenario's fake service answers with, a recorded run. Keep it to what a test outside packages/host imports.
import * as fs from "node:fs";
import type { CodeCard } from "@codeboard/core";
import { analysisOf } from "../src/analysis";
import { cardForFileSym } from "../src/cards";
import type { HostContext } from "../src/context";

export { animWebp, apng, faceFrames, gif, png, type Paint, type Rgba } from "./images";
export { nodeWorkspace, type TestWorkspace } from "./node-workspace";
export { analysisReady, startAnalysis } from "../src/analysis";
export { SYS_FOCUS } from "../src/imageai";
export { captureRun, runApply } from "../src/runs";
export { highlight } from "../src/views";

/** A card for the symbol qual of the file abs (nth of several with that name, -1 the last), as cx's Add Function makes it */
export async function symbolCard(cx: HostContext, abs: string, qual: string, nth = 0): Promise<CodeCard> {
  const sym = analysisOf(cx.langOf(abs), fs.readFileSync(abs, "utf8"))
    .symbols.filter((x) => x.qual === qual)
    .at(nth);
  if (!sym) throw new Error(`no ${qual} in ${abs}`);
  return (await cardForFileSym(cx, abs, sym))!.card as CodeCard;
}
