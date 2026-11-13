// 纯常量（毫秒）：测试要等"这么久之内不该出"时用同一个数，不另抄一份
/** 选区停住多久后出选中工具条（拖选、⇧方向键扩选的途中不出） */
export const TOOLBAR_SETTLE = 400;
/** How long after a single click the markers around the caret show (a double-click's second press lands before) */
export const REVEAL_AFTER_CLICK = 450;
/** How long an image address must stay unchanged before the image under its source loads (typing `](https://…` would
 *  otherwise request every prefix: h, ht, htt…) */
export const IMAGE_SETTLE = 400;
/** How long an image takes to slide, and its source line to fade in, when the caret opens or closes the image's source */
export const IMAGE_SLIDE = 150;
/** A code block's or table's toolbar band grows out of the block's top edge in this long */
export const BAND_SHOW = 140;
/** …and sinks back in this long */
export const BAND_HIDE = 110;
/** How long a band waits before it hides, so the pointer crossing from the block onto its band does not flicker it */
export const BAND_GRACE = 80;
/** A table's rows or columns sliding aside during a drag, the dragged one gliding into its place, inserts and deletes */
export const TABLE_SLIDE = 160;
