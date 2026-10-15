// 线条图标：16×16，1.4px 描边，跟随文字颜色
import type { JSX } from "solid-js";

const P: Record<string, string> = {
  plus: "M8 3.5v9M3.5 8h9",
  minus: "M4 8h8",
  fit: "M3 6V3h3M10 3h3v3M13 10v3h-3M6 13H3v-3",
  more: "M3.5 8h.01M8 8h.01M12.5 8h.01",
  chev: "M4.5 6.5 8 10l3.5-3.5",
  chevR: "M6.5 4.5 10 8l-3.5 3.5",
  left: "M10 4 6 8l4 4",
  right: "m6 4 4 4-4 4",
  close: "m4.5 4.5 7 7M11.5 4.5l-7 7",
  play: "M5 3.5v9l7-4.5z",
  search: "M7 11.5a4.5 4.5 0 1 0 0-9 4.5 4.5 0 0 0 0 9ZM10.5 10.5 13.5 13.5",
  note: "M4 2.5h6l2.5 2.5v8.5h-8.5zM10 2.5V5h2.5M6 8h4.5M6 10.5h3",
  code: "M6 4.5 2.5 8 6 11.5M10 4.5l3.5 3.5-3.5 3.5",
  image: "M2.5 3.5h11v9h-11zM2.5 10.5l3-3 3 3 2-2 3 3M10 6.5h.01",
  web: "M8 13.5a5.5 5.5 0 1 0 0-11 5.5 5.5 0 0 0 0 11ZM2.5 8h11M8 2.5c1.6 1.6 2.3 3.4 2.3 5.5S9.6 11.9 8 13.5M8 2.5C6.4 4.1 5.7 5.9 5.7 8s.7 3.9 2.3 5.5",
  section: "M2.5 4.5h3l1 1.5h7v7.5h-11z",
  link: "M6.5 9.5l3-3M5.2 7.8 3.9 9.1a2.1 2.1 0 0 0 3 3l1.3-1.3M10.8 8.2l1.3-1.3a2.1 2.1 0 0 0-3-3L7.8 5.2",
  text: "M3.5 4.5v-1h9v1M8 3.5v9M6.5 12.5h3",
  undo: "M5.5 4 2.5 7l3 3M3 7h6.5a3.5 3.5 0 0 1 0 7H7",
  redo: "M10.5 4l3 3-3 3M13 7H6.5a3.5 3.5 0 0 0 0 7H9",
  lock: "M4.5 7.5h7v6h-7zM6 7.5V5.5a2 2 0 0 1 4 0v2",
  unlock: "M4.5 7.5h7v6h-7zM6 7.5V5.5a2 2 0 0 1 3.9-.6",
  loop: "M11.5 5.5A4.2 4.2 0 1 0 12.3 9M11.5 2.5v3h-3",
  layout: "M2.5 2.5h11v11h-11zM6.5 2.5v11",
  focus: "M2.5 5.5v-3h3M10.5 2.5h3v3M13.5 10.5v3h-3M5.5 13.5h-3v-3",
  pin: "M9.5 2.5l4 4-2 1-2.5 2.5-.5 2.5-5-5 2.5-.5L8.5 4.5z M5.5 10.5l-3 3",
  eye: "M1.5 8s2.4-4.5 6.5-4.5S14.5 8 14.5 8s-2.4 4.5-6.5 4.5S1.5 8 1.5 8ZM8 10a2 2 0 1 0 0-4 2 2 0 0 0 0 4Z",
  swap: "M3 5.5h9.5l-2.5-2.5M13 10.5H3.5L6 13",
  check: "M3.5 8.5l3 3 6-7",
  alignL: "M2.5 2.5v11M5 5h8M5 10.5h5",
  alignC: "M8 2.5v11M4 5h8M5.5 10.5h5",
  alignR: "M13.5 2.5v11M3 5h8M6 10.5h5",
  alignT: "M2.5 2.5h11M5 5v8M10.5 5v5",
  alignB: "M2.5 13.5h11M5 3v8M10.5 6v5",
  distH: "M2.5 2.5v11M13.5 2.5v11M6 5v6h4V5z",
  distV: "M2.5 2.5h11M2.5 13.5h11M5 6h6v4H5z",
  sameW: "M2.5 5h11M2.5 11h11M2.5 3v4M13.5 3v4M2.5 9v4M13.5 9v4",
  external: "M9 2.5h4.5V7M13.5 2.5 7.5 8.5M11.5 9.5v4h-9v-9h4",
  copy: "M5.5 5.5h8v8h-8zM10.5 5.5v-3h-8v8h3",
  trash: "M3 4.5h10M6.5 4.5v-2h3v2M4.5 4.5l.5 9h6l.5-9",
  dot: "M8 8h.01",
};

export function Icon(p: { name: keyof typeof P | string; size?: number; class?: string; style?: JSX.CSSProperties }) {
  return (
    <svg class={`ico ${p.class ?? ""}`} viewBox="0 0 16 16" width={p.size ?? 16} height={p.size ?? 16} aria-hidden="true" style={p.style}>
      <path d={P[p.name] ?? ""} />
    </svg>
  );
}
