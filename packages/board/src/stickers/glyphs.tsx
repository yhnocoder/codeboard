// 内置贴纸：彩色圆底 + 白色线条（各主题在 themes.css 里换画法）；线条是 Lucide 的造型（ISC 许可，见 public/icons/LICENSE-lucide.txt），
// d / fill 由 tools/icons/gen.mjs 从 tools/icons/icons.src.mjs 写入。Emoji 直接用系统字体；自定义包（Iconify JSON / 图片文件夹）由插件读本地目录。
// 位图用原生 <img> 画（宿主认过格式的 data: URL），动图由浏览器自己播。动图在白板上只在看得见、且是完整档（不是概览 / 地图档）时播，
// 别的时候换成第一帧的静态图（第一次要用时解一帧画进 canvas，存成 PNG data: URL，每个图标一份）：屏幕外、缩小了的动图不再每帧重画。
// 播不播由外面用 GlyphPlay 告诉（画布上的贴纸看自己在不在屏幕附近，选图标面板看指针在不在格子上），没人说就一直播
import { createContext, createMemo, createSignal, Show, useContext, type Accessor, type JSX } from "solid-js";
import type { IconRef, StickerIcon, StickerPack } from "@codeboard/core";
import DOMPurify from "dompurify";
import { ask } from "../host";

export type Builtin = { name: string; label: string; color: string; d?: string; fill?: string; text?: string };
export const BUILTIN: Builtin[] = [
  { name: "star", label: "Important", color: "#E3A132", fill: "M11.762 7.148a.265 .265 0 0 1 .475 0l1.155 2.339a1.061 1.061 0 0 0 .797 .58l2.583 .378a.265 .265 0 0 1 .147 .452l-1.868 1.819a1.061 1.061 0 0 0-.305 .939l.441 2.57a.265 .265 0 0 1-.385 .28l-2.309-1.214a1.061 1.061 0 0 0-.986 0L9.198 16.505a.265 .265 0 0 1-.385-.28l.44-2.569a1.061 1.061 0 0 0-.305-.94L7.08 10.898a.265 .265 0 0 1 .147-.453l2.582-.377a1.061 1.061 0 0 0 .799-.58z" },
  { name: "question", label: "Question", color: "#4C8BF5", d: "M9.75 10.125a2.25 2.25 0 0 1 4.373 .75c0 1.5-2.122 1.875-2.122 3.375M12 16.5h.008" },
  { name: "exclaim", label: "Attention", color: "#E8743B", d: "M12 7.875v5.625M12 16.5h.008" },
  { name: "check", label: "Understood", color: "#3FA36B", d: "M16.125 9.375 10.5 15 7.875 12.375" },
  { name: "flag", label: "Flag", color: "#D9534F", d: "M8 17V8a.5 .5 0 0 1 .2-.4A3 3 0 0 1 10 7c1.5 0 2.5 1 3.667 1q1 0 1.534-.4A.5 .5 0 0 1 16 8v5a.5 .5 0 0 1-.2 .4A3 3 0 0 1 14 14c-1.5 0-2.5-1-4-1a3 3 0 0 0-2 .764" },
  { name: "zap", label: "Performance", color: "#E0B020", fill: "M12.5 7 7.5 13h4.5l-.5 4 5-6h-4.5l.5-4z" },
  { name: "bug", label: "Bug", color: "#C2453E", d: "M12 16v-4.5M13 9.5a2 2 0 0 1 2 2v1.5a3 3 0 0 1-6 0v-1.5a2 2 0 0 1 2-2zM13.06 7.94 14 7M16.5 16.5a2 2 0 0 0-1.905-2M16.5 8.5a2 2 0 0 1-1.775 1.985M17 12.5h-2M7.5 16.5a2 2 0 0 1 1.905-2M7.5 8.5a2 2 0 0 0 1.775 1.985M9 12.5H7m3-5.5 .94 .94M10.5 9.565V9a1.5 1.5 0 1 1 3 0v.565" },
  { name: "todo", label: "To Check", color: "#6B7280", d: "M9 8.25H15A.75 .75 0 0 1 15.75 9V15A.75 .75 0 0 1 15 15.75H9A.75 .75 0 0 1 8.25 15V9A.75 .75 0 0 1 9 8.25z" },
  { name: "heart", label: "Favourite", color: "#E25D8B", fill: "M7 10.75a2.75 2.75 0 0 1 4.796-1.838 .28 .28 0 0 0 .409 0A2.745 2.745 0 0 1 17 10.75c0 1.145-.75 2-1.5 2.75l-2.746 2.657a1 1 0 0 1-1.5 .01L8.5 13.5c-.75-.75-1.5-1.6-1.5-2.75" },
  { name: "hourglass", label: "Later", color: "#8B6FD6", d: "M8.5 17h7M8.5 7h7M14.5 17v-2.086a1 1 0 0 0-.293-.707L12 12l-2.207 2.207A1 1 0 0 0 9.5 14.914V17M9.5 7v2.086a1 1 0 0 0 .293 .707L12 12l2.207-2.207A1 1 0 0 0 14.5 9.086V7" },
  { name: "warning", label: "Careful", color: "#E8743B", d: "m16.865 15-4-7a1 1 0 0 0-1.74 0l-4 7A1 1 0 0 0 8 16.5h8a1 1 0 0 0 .865-1.5M12 10.5v2M12 14.5h.005" },
  { name: "todo-text", label: "TODO", color: "#8B6FD6", text: "TODO" },
];
const byName = new Map(BUILTIN.map((b) => [b.name, b]));

export const EMOJI = "⭐ ❓ ❗ ✅ 🚩 ⚡ 🐞 📌 ❤️ ⏳ ⚠️ 💡 🔥 👀 🤔 🧪 🧠 🚀 🐢 🔒 📝 🎯 🧩 🔍 📊 🧮 🛠️ 🗑️ ✨ 🎉 😵 🙃".split(" ");
export const STICKER_COLORS = ["#E3A132", "#E8743B", "#D9534F", "#E25D8B", "#8B6FD6", "#4C8BF5", "#3FA36B", "#6B7280"];
export const defaultColor = (i: IconRef) => (i.pack === "builtin" ? byName.get(i.name)?.color : undefined);

// 自定义包：第一次要用时问插件读一次
const [packs, setPacks] = createSignal<StickerPack[] | null>(null);
let loading: Promise<void> | null = null;
export function loadPacks(force = false) {
  if (loading && !force) return loading;
  loading = ask("stickerPacks", {}).then((p) => void setPacks(p ?? []), () => void setPacks([]));
  return loading;
}
export { packs };
/** 自定义包里的图标；包还没读过就去读（白板上有自定义贴纸时，不用先打开选图标面板） */
const iconOf = (i: IconRef): StickerIcon | undefined => {
  const ps = packs();
  if (!ps) { void loadPacks(); return undefined; }
  return ps.find((p) => p.id === i.pack)?.icons.find((x) => x.name === i.name);
};
type Bitmap = Extract<StickerIcon, { img: string }>;
export const bitmapOf = (i: IconRef): Bitmap | undefined => { const ic = iconOf(i); return ic && "img" in ic ? ic : undefined; };
// 包里的 SVG 是用户目录里的文件：画之前用 DOMPurify（svg 配置）清洗，去掉脚本、事件属性、javascript: 链接、foreignObject、<style>；按图标缓存
const clean = new WeakMap<object, string>();
const svgOf = (i: IconRef) => {
  const ic = iconOf(i);
  if (!ic || !("svg" in ic)) return undefined;
  let s = clean.get(ic);
  if (s === undefined) clean.set(ic, s = DOMPurify.sanitize(ic.svg, { USE_PROFILES: { svg: true, svgFilters: true }, FORBID_TAGS: ["style"] }));
  return s;
};

/** 动图现在能不能播：画布上的贴纸、选图标面板各自提供；默认一直播（放贴纸时的影子、别的小地方） */
export const GlyphPlay = createContext<Accessor<boolean>>(() => true);

// 动图的第一帧（静态 PNG data: URL），按图标缓存；要用时才解码，解码在 createImageBitmap 里（不占主线程），画一次 canvas。
// 一个接一个做（每个各占一个任务）：打开一整包动图的面板时几百个第一帧不挤在一帧里
const STILL_MAX = 480; // 最大 240px 的贴纸在 2x 屏上够用；更大的原图缩下来，data: URL 不用太大
const stills = new WeakMap<Bitmap, Accessor<string | undefined>>();
let stillQueue = Promise.resolve();
function stillOf(ic: Bitmap): Accessor<string | undefined> {
  let a = stills.get(ic);
  if (a) return a;
  const [url, setUrl] = createSignal<string>();
  stills.set(ic, a = url);
  stillQueue = stillQueue.then(async () => {
    const [head, b64] = ic.img.split(",", 2);
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const bm = await createImageBitmap(new Blob([bytes], { type: head.slice(5, head.indexOf(";")) }));
    const k = Math.min(1, STILL_MAX / Math.max(bm.width, bm.height));
    const cv = document.createElement("canvas");
    cv.width = Math.max(1, Math.round(bm.width * k)); cv.height = Math.max(1, Math.round(bm.height * k));
    cv.getContext("2d")!.drawImage(bm, 0, 0, cv.width, cv.height);
    bm.close();
    setUrl(cv.toDataURL("image/png"));
  }).catch(() => void setUrl(ic.img)); // 解不出第一帧就照原样画
  return a;
}

/** 位图贴纸：原生 <img>，在方框里按比例缩放（object-fit: contain）；动图不能播时换成第一帧 */
function BitmapGlyph(p: { icon: IconRef; ic: Bitmap; class?: string; style: JSX.CSSProperties }) {
  const may = useContext(GlyphPlay);
  // 只有动图跟踪「能不能播」（画布上的贴纸据此跟踪镜头）；镜头每帧变，这里只在播 / 停切换时才换 src
  const play = createMemo(() => !!p.ic.anim && may());
  const src = () => (!p.ic.anim || play() ? p.ic.img : stillOf(p.ic)());
  return <img class={`glyph img ${p.class ?? ""}`} classList={{ anim: !!p.ic.anim, paused: !!p.ic.anim && !play() }} style={p.style} src={src()} alt="" draggable={false}
    data-pack={p.icon.pack} data-name={p.icon.name} />;
}

/** 一个贴纸的样子；size = 像素 */
export function Glyph(p: { icon: IconRef; color?: string; size: number; class?: string; style?: JSX.CSSProperties }) {
  const b = () => (p.icon.pack === "builtin" ? byName.get(p.icon.name) : undefined);
  const col = () => p.color ?? defaultColor(p.icon) ?? "currentColor";
  const base = (): JSX.CSSProperties => ({ width: `${p.size}px`, height: `${p.size}px`, ...p.style });
  return (
    <Show when={p.icon.pack !== "emoji"} fallback={<span class={`glyph emoji ${p.class ?? ""}`} style={{ ...base(), "font-size": `${p.size * 0.86}px` }}>{p.icon.name}</span>}>
      <Show when={b()} fallback={
        <Show when={svgOf(p.icon)} fallback={
          <Show when={bitmapOf(p.icon)} keyed fallback={<span class={`glyph missing ${p.class ?? ""}`} style={base()} data-tip={`Missing icon ${p.icon.pack}:${p.icon.name}`} />}>
            {(ic) => <BitmapGlyph icon={p.icon} ic={ic} class={p.class} style={base()} />}
          </Show>}>
          <span class={`glyph custom ${p.class ?? ""}`} style={{ ...base(), color: col() }} innerHTML={svgOf(p.icon)} />
        </Show>}>
        <Show when={!b()!.text} fallback={<span class={`glyph tag bi ${p.class ?? ""}`} style={{ height: `${p.size}px`, "font-size": `${p.size * 0.5}px`, "--c": col(), ...p.style }}>{b()!.text}</span>}>
          <svg class={`glyph bi ${p.class ?? ""}`} viewBox="0 0 24 24" style={{ ...base(), "--c": col() }} aria-hidden="true">
            <circle class="bg" cx="12" cy="12" r="11" fill={col()} />
            <Show when={b()!.d}><path class="fg" d={b()!.d} fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" /></Show>
            <Show when={b()!.fill}><path class="fgf" d={b()!.fill} fill="#fff" stroke="#fff" stroke-width="1" stroke-linejoin="round" /></Show>
          </svg>
        </Show>
      </Show>
    </Show>
  );
}
