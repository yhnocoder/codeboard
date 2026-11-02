// 贴在字上的手写标注：每一行上面 / 下面一条窄轨道（只有有标注的行才有），被标的字底下一块淡色（CodeBody 的 rowbgs 里）
import { createMemo, For } from "solid-js";
import { setEditing, type AnnotDraft } from "../../state/ui";
import { Editable } from "../../ui/Editable";
import { annotDraft, annotKey, annotMenu, commitDraft, setAnnotText } from "../../actions/annots";
import type { CodeCx, LineRow } from "./cx";

export type Ann = {
  i: number;
  text: string;
  color: string;
  below: boolean;
  from: number;
  to: number;
  draft?: AnnotDraft;
};

/** 第 i 个字前面占几个等宽的格（Tab 跳到下一个 4 的倍数，和 .src 的 tab-size 一样） */
function vcol(t: string, i: number) {
  let c = 0;
  for (let k = 0; k < i && k < t.length; k++) c = t[k] === "\t" ? c + 4 - (c % 4) : c + 1;
  return c;
}

export function useAnnots(cx: CodeCx) {
  const annots = createMemo(() => {
    const m = new Map<string, Ann[]>();
    const add = (seg: string, line: number, a: Ann) => {
      const k = `${seg}:${line}`;
      const l = m.get(k);
      if (l) l.push(a);
      else m.set(k, [a]);
    };
    for (const s of cx.card().segments) {
      (s.annots ?? []).forEach((a, i) => {
        const t = s.text[a.line - s.start] ?? "";
        add(s.id, a.line, {
          i,
          text: a.text,
          color: a.color ?? "blue",
          below: !!a.below,
          from: vcol(t, a.from),
          to: vcol(t, a.to),
        });
      });
    }
    const d = annotDraft();
    if (d?.card === cx.card().id) {
      const s = cx.segById(d.seg),
        t = s?.text[d.line - (s?.start ?? 0)] ?? "";
      const color = s?.annots?.[s.annots.length - 1]?.color ?? "blue";
      add(d.seg, d.line, { i: -1, text: "", color, below: false, from: vcol(t, d.from), to: vcol(t, d.to), draft: d });
    }
    return m;
  });
  return {
    /** The notes on a line's rail above it (below = under it), if any */
    railOf: (l: LineRow, below: boolean) => {
      const as = annots()
        .get(`${l.seg}:${l.line}`)
        ?.filter((a) => a.below === below);
      return as?.length ? as : undefined;
    },
    /** Each note with its row: the tint under the words it marks */
    annotRows: createMemo(() => {
      const out: { row: number; a: Ann }[] = [];
      cx.rows().forEach((r, i) => {
        if (r.t === "line") for (const a of annots().get(`${r.seg}:${r.line}`) ?? []) out.push({ row: i, a });
      });
      return out;
    }),
  };
}

/** shift = how far the text moved left with the common indentation hidden (as .src.ded .l's text-indent) */
export function AnnotRail(q: { cx: CodeCx; l: LineRow; list: Ann[]; below: boolean; shift: string }) {
  const id = () => q.cx.card().id;
  return (
    <div class="arail" classList={{ below: q.below }} aria-hidden="true" data-nodrag>
      <For each={q.list}>
        {(a) => (
          <>
            <span class={`aanc hc-${a.color}`} style={{ left: `calc(${q.shift} + ${a.from}ch)` }}>
              <span
                class="alab"
                data-tip={a.draft ? undefined : "Double-click to edit · Right-click for more"}
                onDblClick={(e) => {
                  e.stopPropagation();
                  if (!a.draft) setEditing({ kind: "annot", id: annotKey(id(), q.l.seg, a.i) });
                }}
                onContextMenu={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  const s = q.cx.segById(q.l.seg);
                  const x = s?.annots?.[a.i];
                  if (x) annotMenu(id(), q.l.seg, a.i, x, e.clientX, e.clientY);
                }}
              >
                <Editable
                  class="alt"
                  kind="annot"
                  id={a.draft ? "draft" : annotKey(id(), q.l.seg, a.i)}
                  value={a.text}
                  placeholder="Write a note…"
                  onCommit={(v) => (a.draft ? commitDraft(a.draft, v) : setAnnotText(id(), q.l.seg, a.i, v))}
                />
              </span>
            </span>
            <span class={`aanc hc-${a.color}`} style={{ left: `calc(${q.shift} + ${(a.from + a.to) / 2}ch)` }}>
              <i class="aarr" />
            </span>
          </>
        )}
      </For>
    </div>
  );
}
