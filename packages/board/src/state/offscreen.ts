// Which cards have their content hidden for being far off screen: cull.ts decides it, lodcards.ts counts showing it again
// in the frame a card leaves the map level
import { createStore } from "solid-js/store";

const [off, setOff] = createStore<Record<string, boolean>>({});
/** 这张卡离屏幕很远，内容不画 */
export const offscreen = (id: string) => !!off[id];
export const setOffscreen = (id: string, v: boolean) => setOff(id, v);
