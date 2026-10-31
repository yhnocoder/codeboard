import { unwrap } from "solid-js/store";
import { uid, type Anchor, type PeekDef, type SearchItem, type Sidenote } from "@codeboard/core";
import { toast } from "../state/toast";
import { closePop, updatePop, type Pop } from "../state/pop";
import { ask } from "../host";
import { hostRect } from "./common";
import { addCards } from "./create";
import { requestViews } from "../state/views";
import { addSidenotes } from "./notes";
import { addLink } from "./links";

type PeekPop = Extract<Pop, { kind: "peek" }>;
type CodeNote = Omit<Extract<Sidenote, { kind: "code" }>, "id">;

/** 定义预览钉成代码 Sidenote：Follow 跟过的中间步骤（如 get_context = context._default_context.get_context）按顺序一起放，最后是最终定义 */
export function pinPeek(id: number, p: PeekPop, def: PeekDef) {
  const at: Anchor = { card: p.card, seg: p.seg, lines: [p.line, p.line] };
  const steps = [...(p.trail ?? []), def];
  const segs = steps.map((k) => ({ ...structuredClone(unwrap(k.seg)), id: uid("s") }));
  addSidenotes(segs.map((code): CodeNote => ({ at, kind: "code", code })));
  // 展示数据用定义预览里那几行（段的 id 换了，重新要一次）
  requestViews(segs);
  toast(steps.length > 1 ? `Pinned ${steps.length} steps as Sidenotes` : "Pinned as Sidenote");
  closePop(id);
}

/** 定义放成一张新卡，放在这张卡右边，连一条箭头过去 */
export function placePeek(id: number, p: PeekPop, def: PeekDef) {
  const r = hostRect(p.card);
  if (!r) return;
  const card = uid("c");
  const seg = structuredClone(unwrap(def.seg));
  addCards([{ card: { id: card, kind: "code", segments: [seg] }, views: {}, w: 480 }], { at: { x: r.x + r.w + 48, y: r.y } });
  requestViews([seg]);
  addLink({ card: p.card, seg: p.seg, line: p.line }, { card });
  closePop(id);
}

/** Follow：跟到下一层定义（a = b.c 这种转手），这一步记进 trail */
export function followPeek(id: number, def: PeekDef) {
  const f = def.follow;
  if (!f) return;
  const word = f.label.split(".").pop()!;
  const none = { none: "No definition found", word: f.label };
  const set = (data: PeekPop["data"]) => updatePop(id, "peek", (q) => ({ ...q, data }));
  updatePop(id, "peek", (q) => ({ ...q, trail: [...(q.trail ?? []), def], data: undefined }));
  ask("peek", { seg: def.seg, line: f.line, col: f.col, word, at: { path: f.path, line: f.line, col: f.col } })
    .then((r) => set(r ?? none))
    .catch(() => set(none));
}

/** 加 Sidenote 的 Code 页：搜函数和文件（最多 8 个） */
export const searchCodeForNote = (q: string): Promise<SearchItem[]> =>
  ask("search", { q, scope: "code" }).then((r) => r.filter((x) => x.kind === "symbol" || x.kind === "file").slice(0, 8)).catch(() => []);
