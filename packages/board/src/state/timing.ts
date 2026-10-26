// The board's fixed delays, in ms. Pure constants (no Solid, no DOM): the harness scenarios import them too, so a test that
// checks that something does not happen before one of these delays is over waits for the named delay, not a magic number.

/** The camera counts as moving until this long after its last change (`.world.moving`, camera.ts) */
export const CAM_STILL = 180;
/** The camera position is saved once it has not changed for this long (App.tsx), then sent after LIVE_DELAY */
export const CAM_SETTLE = 600;
/** Live changes (drag in progress, a settled camera) go to the host this long after the last one (store.ts) */
export const LIVE_DELAY = 800;
/** After the host refused a patch, the whole board is sent again once, this long later (store.ts) */
export const RESEND_DELAY = 2000;
/** Two clicks on the same thing within this long (and 6 px) are a double-click (interact.ts isDbl; TUNE.dblClick's default) */
export const DBL_CLICK = 420;
/** Hovering a word in code this long shows its definition (TUNE.peekDelay's default) */
export const PEEK_DELAY = 800;
/** After the pointer leaves an arrow or a card, its hover (the + on the arrow, the arrow lifted above the cards) lasts this long
 *  (hover.ts; TUNE.linkLeave's default) */
export const LINK_LEAVE = 300;
/** The selection (cards, code lines) is reported to the host this long after its last change (store.ts reportSelection) */
export const SEL_REPORT = 60;
/** A tilted card turns straight when its editing starts, and back when it ends, over this long (tilt.ts) */
export const TILT_MS = 200;
