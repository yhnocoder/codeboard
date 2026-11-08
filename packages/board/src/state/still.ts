// The board drawn as a still picture (BoardOptions.still: the phone viewer's tile renderer). Set once at boot, before the board
// renders. No imports but Solid, so motion.ts and the camera can read it without a cycle
import { createSignal } from "solid-js";

const [still, setStill] = createSignal(false);
/** Drawn as a picture: no editing chrome or affordances, no animation, the camera never counts as moving, prose never drawn as
 *  bars, and the summary layer always built (its extent is part of the picture) */
export { still, setStill };
