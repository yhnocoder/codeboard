import { cardById } from "../state/store";
import { boardSignal, boardTimer } from "../state/root";
import { PASTE_CHIP_IDLE } from "../state/timing";

/**
 * 粘贴 / ⌘D 出来的副本右下角的小条：Copy ✓ | Reference。pairs = [副本, 原卡]；ref = 现在是 Reference。
 * 指针不在上面 PASTE_CHIP_IDLE 后、点了别处、副本挪了或改了（Canvas.tsx PasteChip 看着）就收起
 */
export const [pasteChip, setPasteChip] = boardSignal<{ pairs: [string, string][]; ref: boolean } | null>(null);
const chipTimer = boardTimer();
export function offerReference(pairs: [string, string][]) {
  const ok = pairs.filter(([n, o]) => {
    const a = cardById(n)?.card,
      b = cardById(o)?.card;
    return a && b && a.kind !== "compare" && a.kind !== "board" && a.kind === b.kind;
  });
  setPasteChip(ok.length ? { pairs: ok, ref: false } : null);
  if (ok.length) armChip();
}
/** 指针离开小条后重新计时；hold = 指针在上面，不收 */
export function armChip(hold = false) {
  chipTimer.stop();
  if (!hold) chipTimer.start(() => setPasteChip(null), PASTE_CHIP_IDLE);
}
export function closeChip() {
  chipTimer.stop();
  setPasteChip(null);
}
