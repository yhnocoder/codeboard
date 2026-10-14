import type { Card, CodeCard } from "../store";
import { sizes } from "../store";

// 代码卡片的固定排版尺寸，箭头要按行定位
export const HEADER = 40;
export const PAD = 6;
export const LH = 20;

export type Rect = { x: number; y: number; w: number; h: number };
export function rectOf(c: Card): Rect {
  const s = sizes[c.id];
  return { x: c.x, y: c.y, w: s?.w ?? c.w, h: s?.h ?? (c.type === "group" ? c.h : 120) };
}

export function lineY(c: CodeCard, line: number): number {
  if (c.collapsed || line < c.start || line > c.end) return c.y + HEADER / 2;
  return c.y + HEADER + PAD + (line - c.start) * LH + LH / 2;
}

export type Side = "l" | "r" | "t" | "b";
export const NORMAL: Record<Side, [number, number]> = { r: [1, 0], l: [-1, 0], t: [0, -1], b: [0, 1] };

export function overlaps(a: Rect, b: Rect, gap = 24) {
  return a.x < b.x + b.w + gap && b.x < a.x + a.w + gap && a.y < b.y + b.h + gap && b.y < a.y + a.h + gap;
}
