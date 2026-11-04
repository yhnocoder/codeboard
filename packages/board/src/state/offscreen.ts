// Which cards have their content hidden for being far off screen: cull.ts decides it
import { onBoard } from "./store";
import { boardStore } from "./root";

const [off, setOff] = boardStore<Record<string, boolean>>(() => ({}), onBoard);
/** 这张卡离屏幕很远，内容不画 */
export const offscreen = (id: string) => !!off[id];
export const setOffscreen = (id: string, v: boolean) => setOff(id, v);
