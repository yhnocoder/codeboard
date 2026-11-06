// How a code card is measured for keeping it fitted (core commands keepFitted)
import type * as C from "@codeboard/core/commands";
import { naturalSize, chromeOf, CODE_MAX } from "../state/measure";

/** When what a code card shows under its lines changes (an Always Show sidenote, a Highlight's gaps and marker): the code area's
 *  height that shows all its content at its width now, and the width Fit Content would give it (the gutter as drawn now) */
export const fitMeasure: C.FitMeasure = {
  measure: (id) => {
    const n = naturalSize(id, "now");
    return n?.body === undefined ? null : { h: n.h - chromeOf(id), body: n.body, w: n.w };
  },
  codeMax: CODE_MAX,
};
