// 画布这一块（箭头、Section、贴纸、旁注、多选、LOD、主题）的小样共用：搭白板的小工具、假的贴纸包
import { onCleanup, onMount } from "solid-js";
import type { Board, Card, CodeCard, End, Link, Section, StickerPack } from "@codeboard/core";
import { loadPacks } from "../../src/stickers/glyphs";
import { addReplies } from "./host";

/** 代码卡里第一行含 word 的那一行（行端） */
export function ln(c: CodeCard, word: string): End {
  const s = c.segments[0];
  const i = s.text.findIndex((t) => t.includes(word));
  if (i < 0) throw new Error(`No line with "${word}" in ${s.scope ?? s.path}`);
  return { card: c.id, seg: s.id, line: s.start + i };
}
export const whole = (c: Card): End => ({ card: c.id });

type LinkExtra = Omit<Partial<Link>, "id" | "from" | "to">;
export function arrow(b: Board, id: string, from: End, to: End, x: LinkExtra = {}): Link {
  const L = { id, from, to, ...x } as Link;
  b.links.push(L);
  return L;
}
/** Section 和它的成员卡（成员按 Place.section，框由成员撑开） */
export function section(b: Board, s: Section, members: string[] = []): Section {
  b.sections.push(s);
  for (const id of members) b.place[id].section = s.id;
  return s;
}

export const SECTION_COLORS = ["none", "sand", "blue", "green", "pink"] as const;
export const LINK_COLORS = ["grey", "orange", "blue", "green"] as const;

// 假宿主（host.ts）对 stickerPacks 回空的；贴纸的小样挂着时多一个文件夹包（位图、动图）。
// 图在 fixtures/assets/stickers，宿主给的是 data: URL（动图的第一帧要从它解码），所以先取回来转一次
const PACK_FILES: [name: string, file: string, anim?: true][] = [
  ["smile", "smile.png"],
  ["banner", "banner.png"],
  ["wink", "wink.gif", true],
  ["blink", "blink.png", true],
];
export const PACK = "Party";
let pack: Promise<StickerPack> | undefined;
const toData = (b: Blob) =>
  new Promise<string>((ok, fail) => {
    const r = new FileReader();
    r.onload = () => ok(r.result as string);
    r.onerror = fail;
    r.readAsDataURL(b);
  });
const packOf = () =>
  (pack ??= Promise.all(
    PACK_FILES.map(async ([name, file, anim]) => {
      const img = await toData(await (await fetch(`sb-assets/stickers/${file}`)).blob());
      return anim ? { name, img, anim } : { name, img };
    }),
  ).then((icons) => ({ id: PACK, name: PACK, icons })));

/** 在组件里调用：挂着的时候宿主有 Party 这个包，卸下时换回没有包（别的小样的选图标面板不多一页） */
export function usePacks() {
  const off = addReplies({ stickerPacks: () => packOf().then((p) => [p]) });
  // 白板加载（换白板）会让还没回的请求都失败（包就成了空的），所以等白板挂好再问
  onMount(() => requestAnimationFrame(() => void loadPacks(true)));
  // 先撤掉回答再重新问：问到的是没有包
  onCleanup(() => {
    off();
    void loadPacks(true);
  });
}
