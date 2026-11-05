// 白板的印章（Mark，core seal.ts）：别的白板、侧栏、命令面板改一块白板的印章。白板文件归宿主管：开着的白板交给它自己改
// （它的一步撤销，存回来），关着的直接改文件。存了以后白板列表（boards，带着印章）重推给所有面板，[[引用]] 跟着重画
import {
  SEAL_COLORS,
  cleanSealText,
  defaultSealColor,
  defaultSealText,
  putSeal,
  sealClash,
  sealOf,
  sealToKeep,
  type BoardSeal,
  type SealColor,
} from "@codeboard/core";
import type { BoardHost } from "./boards";

/** 白板 id 换上这个印章（null = 用默认的） */
export async function setSeal(panels: BoardHost, id: string, seal: BoardSeal | null) {
  const p = panels.get(id);
  if (p) {
    p.post({ type: "setSeal", seal });
    return;
  }
  await panels.store.update(id, (b) => {
    const was = JSON.stringify(b.seal ?? null);
    putSeal(b, seal);
    if (JSON.stringify(b.seal ?? null) === was) return false;
  });
}

const colorName = (c: SealColor) => c[0].toUpperCase() + c.slice(1);

/** 侧栏 / 命令面板的 Edit Mark…：编辑器自己的输入框（字，超长、同一本书里重了提示）和颜色选单（第一项用默认的） */
export async function editSealPrompt(panels: BoardHost, id: string) {
  const ui = panels.cx.ws.ui;
  const b = await panels.store.load(id);
  if (!b) return;
  const metas = await panels.metas(),
    cur = sealOf(b),
    def = defaultSealText(b.name.trim());
  const text = await ui.input({
    title: `Edit Mark of “${b.name.trim()}”`,
    prompt: `Up to 5 CJK or 12 other characters. Empty: ${def || "·"}`,
    value: cur.text,
    check: (v) => {
      const t = v.replace(/\s/g, "");
      if (cleanSealText(t) !== t) return { message: "Too long: up to 5 CJK and 12 other characters." };
      const other = sealClash(id, t || def, metas);
      return other ? { message: `“${other.name.trim()}” also uses ${t || def}`, warn: true } : undefined;
    },
  });
  if (text === undefined) return;
  const dc = defaultSealColor(id);
  const pick = await ui.pick(
    [
      { label: "Use Default", description: colorName(dc), color: dc },
      ...SEAL_COLORS.map((c) => ({
        label: colorName(c),
        description: c === cur.color ? "current" : undefined,
        color: c,
      })),
    ],
    { title: `Mark colour of “${b.name.trim()}”`, placeHolder: "Colour of the mark" },
  );
  if (!pick) return;
  await setSeal(panels, id, sealToKeep(b, text, pick.color) ?? null);
}
