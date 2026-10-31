// The board's fixed delays, in ms. Pure constants (no Solid, no DOM): the harness scenarios import them too, so a test that
// checks that something does not happen before one of these delays is over waits for the named delay, not a magic number.

/** The camera counts as moving until this long after its last change (`.world.moving`, camera.ts) */
export const CAM_STILL = 180;
/** The camera position is saved once it has not changed for this long (BoardView.tsx), then sent after LIVE_DELAY */
export const CAM_SETTLE = 600;
/** Live changes (drag in progress, a settled camera) go to the host this long after the last one (save.ts) */
export const LIVE_DELAY = 800;
/** After the host refused a patch, the whole board is sent again once, this long later (save.ts) */
export const RESEND_DELAY = 2000;
/** Two clicks on the same thing within this long (and 6 px) are a double-click (interact.ts isDbl; TUNE.dblClick's default) */
export const DBL_CLICK = 420;
/** Dragging cards or a Section faster than this (screen px/s, smoothed over the pointer moves) does not snap (interact.ts snapPace;
 *  TUNE.snapSpeed's default) */
export const SNAP_SPEED = 700;
/** A drag that has not moved for this long counts as stopped (speed 0), and snaps where it is (interact.ts snapPace) */
export const SNAP_SETTLE = 110;
/** Hovering a word in code this long shows its definition (TUNE.peekDelay's default) */
export const PEEK_DELAY = 800;
/** After the pointer leaves an arrow or a card, its hover (the + on the arrow, the arrow lifted above the cards) lasts this long
 *  (hover.ts; TUNE.linkLeave's default) */
export const LINK_LEAVE = 300;
/** The selection (cards, code lines) is reported to the host this long after its last change (selection.ts reportSelection) */
export const SEL_REPORT = 60;
/** A tilted card turns straight when its editing starts, and back when it ends, over this long (tilt.ts) */
export const TILT_MS = 200;
/** A wheel gesture ends after this long without a wheel event: until then it stays with whatever it started on, the canvas or a
 *  scrollable part of a card (interact.ts ownerFor) */
export const WHEEL_GESTURE = 200;
/** The Copy | Reference chip under a pasted or duplicated card goes away after this long without the pointer on it (actions/shared.ts) */
export const PASTE_CHIP_IDLE = 6000;
/** Holding an arrow key: one step at once, then after this long the selected cards glide on, every frame (keymap.ts nudge) */
export const NUDGE_HOLD = 300;
/** …starting at NUDGE_SPEED and easing up to NUDGE_MAX times that over this long */
export const NUDGE_RAMP = 1500;
/** The speed a held arrow key starts gliding at, in screen px per ms (Shift: 10 times) */
export const NUDGE_SPEED = 0.04;
export const NUDGE_MAX = 6;
/** After a press on the board, how long the board takes the keyboard back if the webview's host page takes it from its frame (focus.ts) */
export const CLICK_KEEPS_KEYS = 1000;
/** Dragging an arrow: when the block of a Note it points at changes, its end glides to the new block over this long (interact.ts linkPortDown) */
export const BLOCK_GLIDE = 90;
/** The ports on a Note's block stay this long after the pointer leaves it, so they can be reached on the card's edge (state/blocks.ts) */
export const BLOCK_LEAVE = 200;
/** Folding a Section: the member cards' content cross-fades to skeleton lines over this long before the cards fly into the
 *  title (styles.css .skel uses the same value) */
export const SKEL_OUT = 80;
/** Unfolding: the cards' content cross-fades back from the skeleton over this long as they land (styles.css .skel-in) */
export const SKEL_IN = 100;
/** A deleted card's fade-out (styles.css .card.ghost-out, its longest transition), times the animation speed (--t) */
export const GHOST_OUT = 200;
/** Resting the pointer on something with a tip (data-tip) shows the tip after this long; right after a tip was shown, at once (ui/Menu.tsx) */
export const TIP_DELAY = 500;
/** Fit to Content on a Section: its frame glides (styles.css .sect.fit, 260 ms) and the glide class comes off after this long (actions/edit.ts) */
export const SECTION_FIT = 320;
/** Commits for the version menu: if they arrive within this long the menu opens with them, else it opens loading (actions/versions.ts) */
export const COMMITS_WAIT = 250;
/** A code line stays hovered this long after the pointer leaves it (cards/CodeBody.tsx) */
export const ROW_LEAVE = 200;
/** Resting the pointer on a Web card shows its page preview after this long (cards/WebBody.tsx) */
export const WEB_PEEK_DELAY = 550;
/** A folded Section's member preview fades out over this long when the pointer leaves (canvas/Sections.tsx) */
export const SECTION_PEEK_OUT = 140;
/** Lines that flash (a jump to a line, a call's target) stay lit this long (state/ui.ts flash) */
export const FLASH_MS = 700;
/** A peek closes this long after the pointer leaves the word and the peek (TUNE.peekHide's default) */
export const PEEK_HIDE = 260;
/** An arrow's end slides to the other side of its card over this long (TUNE.sideSlide's default) */
export const SIDE_SLIDE = 120;
/** An arrow fades over this long as it lifts above the cards or drops below them (TUNE.liftFade's default) */
export const LIFT_FADE = 140;
/** A menu's open animation (TUNE.menuOpen's default) */
export const MENU_OPEN = 150;
