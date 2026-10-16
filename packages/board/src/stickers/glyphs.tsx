// 贴纸图标：内置一套（彩色圆底 + 白色线条），Emoji 直接用系统字体，自定义包（Iconify JSON / SVG 文件夹）由插件读本地目录。
import { createSignal, Show, type JSX } from "solid-js";
import type { IconRef, StickerPack } from "@codeboard/core";
import { ask } from "../host";

export type Builtin = { name: string; label: string; color: string; d?: string; fill?: string; text?: string };
export const BUILTIN: Builtin[] = [
  { name: "star", label: "Important", color: "#E3A132", fill: "M12 5.6l1.9 4 4.3.5-3.2 2.9.9 4.3L12 15.1l-3.9 2.2.9-4.3-3.2-2.9 4.3-.5z" },
  { name: "question", label: "Question", color: "#4C8BF5", d: "M9.6 9.4a2.5 2.5 0 1 1 3.4 2.3c-.6.3-1 .8-1 1.5v.5M12 16.6h.01" },
  { name: "exclaim", label: "Attention", color: "#E8743B", d: "M12 7v6.2M12 16.6h.01" },
  { name: "check", label: "Understood", color: "#3FA36B", d: "M7.6 12.4l3 3 5.8-6.6" },
  { name: "flag", label: "Flag", color: "#D9534F", d: "M8.5 18V6.5M8.5 7h7.5l-1.8 3 1.8 3H8.5" },
  { name: "zap", label: "Performance", color: "#E0B020", fill: "M13 5.5 7.5 13h4.3l-.8 5.5L16.5 11h-4.3z" },
  { name: "bug", label: "Bug", color: "#C2453E", d: "M9.4 10a2.6 2.6 0 0 1 5.2 0v3.6a2.6 2.6 0 0 1-5.2 0zM12 10v6M6.8 11.6h2.6M14.6 11.6h2.6M7.3 15.6l2.1-.9M16.7 15.6l-2.1-.9M10.3 7.8l-.9-1.3M13.7 7.8l.9-1.3" },
  { name: "todo", label: "To Check", color: "#6B7280", d: "M8 8h8v8H8z" },
  { name: "heart", label: "Favourite", color: "#E25D8B", fill: "M12 17.8s-5.6-3.4-5.6-7.4A3 3 0 0 1 12 8.9a3 3 0 0 1 5.6 1.5c0 4-5.6 7.4-5.6 7.4z" },
  { name: "hourglass", label: "Later", color: "#8B6FD6", d: "M8.6 6.3h6.8M8.6 17.7h6.8M9.5 6.3c0 3.4 5 3.4 5 5.7s-5 2.3-5 5.7M14.5 6.3c0 3.4-5 3.4-5 5.7s5 2.3 5 5.7" },
  { name: "warning", label: "Careful", color: "#E8743B", d: "M12 6.4l6 10.6H6zM12 10.4v3.1M12 15.3h.01" },
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
  loading = ask<StickerPack[]>("stickerPacks", {}).then((p) => void setPacks(p ?? []), () => void setPacks([]));
  return loading;
}
export { packs };
const svgOf = (i: IconRef) => packs()?.find((p) => p.id === i.pack)?.icons.find((x) => x.name === i.name)?.svg;

/** 一个贴纸的样子；size = 像素 */
export function Glyph(p: { icon: IconRef; color?: string; size: number; class?: string; style?: JSX.CSSProperties }) {
  const b = () => (p.icon.pack === "builtin" ? byName.get(p.icon.name) : undefined);
  const col = () => p.color ?? defaultColor(p.icon) ?? "currentColor";
  const base = (): JSX.CSSProperties => ({ width: `${p.size}px`, height: `${p.size}px`, ...p.style });
  return (
    <Show when={p.icon.pack !== "emoji"} fallback={<span class={`glyph emoji ${p.class ?? ""}`} style={{ ...base(), "font-size": `${p.size * 0.86}px` }}>{p.icon.name}</span>}>
      <Show when={b()} fallback={
        <Show when={svgOf(p.icon)} fallback={<span class={`glyph missing ${p.class ?? ""}`} style={base()} data-tip={`Missing icon ${p.icon.pack}:${p.icon.name}`} />}>
          <span class={`glyph custom ${p.class ?? ""}`} style={{ ...base(), color: col() }} innerHTML={svgOf(p.icon)} />
        </Show>}>
        <Show when={!b()!.text} fallback={<span class={`glyph tag ${p.class ?? ""}`} style={{ height: `${p.size}px`, "font-size": `${p.size * 0.5}px`, background: col(), ...p.style }}>{b()!.text}</span>}>
          <svg class={`glyph ${p.class ?? ""}`} viewBox="0 0 24 24" style={base()} aria-hidden="true">
            <circle cx="12" cy="12" r="11" fill={col()} />
            <Show when={b()!.d}><path d={b()!.d} fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" /></Show>
            <Show when={b()!.fill}><path d={b()!.fill} fill="#fff" /></Show>
          </svg>
        </Show>
      </Show>
    </Show>
  );
}
