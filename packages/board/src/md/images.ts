// Note 里的图：Markdown 写的是存储目录里的相对地址 assets/<内容的 sha1>-<宽>x<高>.<扩展名>（宿主存的，见 host/src/images.ts）。
// 显示、编辑时换成宿主给的 webview 资源地址（host.assetBase，和 Image 卡同一个目录）；文件名里的宽高交给渲染器先留好位置。
// 别的地址（网址、手打的别处的路径）照原样
import { setImageResolver } from "@yhnocoder/markdown";
import { ask } from "../host";
import { toast } from "../state/store";

const SIZED = /-(\d{1,5})x(\d{1,5})\.(?:png|jpg|webp|gif)$/;
let base: string | undefined;
export function setNoteAssets(b: string) {
  if (b === base) return;
  base = b;
  setImageResolver((src) => {
    if (!src.startsWith("assets/")) return undefined;
    const name = src.slice(7), m = SIZED.exec(name);
    return { src: b ? `${b}/${name}` : src, ...(m ? { width: +m[1], height: +m[2] } : {}) };
  });
}

/** 编辑器里粘贴、拖进来、/Image 选的图交给宿主存；存不了（不是这几种图、太大）提示一下，不插 */
export async function saveNoteImage(dataUrl: string): Promise<string | null> {
  try { return await ask("saveImage", { dataUrl }); }
  catch (e) { toast((e as Error).message || "Could not add the image"); return null; }
}
