// 纯常量（毫秒）：测试要等"这么久之内不该出"时用同一个数，不另抄一份
/** 选区停住多久后出选中工具条（拖选、⇧方向键扩选的途中不出） */
export const TOOLBAR_SETTLE = 400;
/** How long after a single click the markers around the caret show (a double-click's second press lands before) */
export const REVEAL_AFTER_CLICK = 450;
/** How long an image address must stay unchanged before the image under its source loads (typing `](https://…` would
 *  otherwise request every prefix: h, ht, htt…) */
export const IMAGE_SETTLE = 400;
