// 子白板框：一张静态的缩略地图。名字和卡数在框外上方（大字）；框里是子白板真实的样子等比缩小：Section 是淡色区域（名字 + 卡数，字号固定），
// 卡是按真实位置、大小的块（Note 纸白、几道灰线代表字，代码卡带一条蓝灰的头，Text 一道线，图片画缩略图），箭头是细线。块上不写字，悬停显示标题。
// 地图拼成一段 SVG 一次放进去（不是每块一个组件）：拖别的卡、平移缩放都不碰它，只有骨架换了（宿主推来新的）、框改了大小才重新拼。
// 点一块：框外弹出那张卡的只读预览（cards/SubPreviews.tsx）；点开的块描边、带和预览一样的编号。双击框还是进子白板
import { createMemo, createSignal, For, Show } from "solid-js";
import { mapFit, mapHtml, type BoardCard, type SkelCard } from "@codeboard/core";
import { flows, placeOf, state } from "../state/store";
import { skels, FRAME_H, pvs, pvCols, clearPreviews, foldPreviews, setPreviewCols } from "../state/subboards";
import { assetSrc } from "../actions/web";
import { Icon } from "../ui/icons";
import { MarkView } from "./CodeHead";

/** 地图上一块的种类图标（提示、预览的标题行用） */
export function skelIcon(c: Pick<SkelCard, "k" | "lk">): string {
  if (c.lk) return c.lk;
  return (
    (
      {
        code: "code",
        note: "note",
        image: "image",
        web: "web",
        links: "link",
        compare: "swap",
        board: "boards",
      } as Record<string, string>
    )[c.k] ?? "note"
  );
}
/** 悬停提示、预览标题里的名字：图片没有 alt、图注时写 Image */
export const skelName = (c: SkelCard) => c.t || (c.k === "image" ? "Image" : c.k === "note" ? "Note" : "Card");

export function BoardBody(p: { card: BoardCard }) {
  const sk = () => skels[p.card.board];
  const pl = () => placeOf(p.card.id);
  // 父白板上的调用图连到这个框：名字前面是它的标记
  const node = createMemo(() => flows().byId.get(p.card.id));
  // 设置 Sub-board Preview = Title Only：框外只有名字和卡数，框里不画地图
  const titleOnly = () => state.host.settings.subPreview === "title";
  const size = createMemo(() => ({ w: pl().w, h: pl().h ?? FRAME_H }), undefined, {
    equals: (a, b) => a.w === b.w && a.h === b.h,
  });
  const fit = createMemo(() => {
    const s = sk();
    return s ? mapFit(s, size().w, size().h) : null;
  });
  const html = createMemo(() => {
    const s = sk(),
      m = fit();
    return s && m && !titleOnly() ? mapHtml(s, m, assetSrc) : "";
  });
  const byId = createMemo(() => new Map((sk()?.cards ?? []).map((c) => [c.id, c])));
  const name = () => p.card.title || sk()?.name || (sk() === null ? "Board not found" : "Loading…");
  const count = () => {
    const s = sk();
    return s ? String(s.n) : "";
  };
  const pv = () => pvs[p.card.id];
  const open = () => (pv()?.open ?? []).filter((id) => byId().has(id));
  // 悬停的那一块：提示它的标题（按着键拖的时候不出）
  const [tip, setTip] = createSignal<string | null>(null);
  const over = (e: PointerEvent) =>
    setTip(e.buttons ? null : ((e.target as Element).closest?.("[data-sub]")?.getAttribute("data-sub") ?? null));
  const at = (c: SkelCard) => {
    const m = fit()!;
    return { x: m.ox + c.x * m.s, y: m.oy + c.y * m.s, w: c.w * m.s, h: c.h * m.s };
  };
  return (
    <>
      <div class="sbhead">
        <Show when={node()}>
          <span class="step" data-drag>
            <MarkView g={node()!} />
          </span>
        </Show>
        {/* 和设计稿一样只有名字和卡数；代码卡的 commit 放进名字的提示里 */}
        <span class="sbname" data-drag title={sk()?.commit ? `${name()} · ${sk()!.commit}` : name()}>
          {name()}
        </span>
        <Show when={sk()}>
          <span class="sbmeta" data-drag title={`${sk()!.n} card${sk()!.n === 1 ? "" : "s"}`}>
            {count()}
          </span>
        </Show>
      </div>
      <Show when={open().length}>
        <div class="sbacts" data-nodrag data-export="strip">
          <button class="sbfold" classList={{ folded: !!pv()?.fold }} onClick={() => foldPreviews(p.card.id)}>
            <b>{open().length}</b>
            {open().length === 1 ? " preview" : " previews"} · {pv()?.fold ? "Show" : "Hide"}
            <Icon name="chev" size={11} />
          </button>
          <span class="sbcolsw" role="group" aria-label="Preview columns">
            <button
              classList={{ on: pvCols(p.card.id) === 1 }}
              aria-label="One column"
              data-tip="Previews in one column"
              onClick={() => setPreviewCols(p.card.id, 1)}
            >
              <svg class="ico" viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">
                <path d="M5.5 2.5h5v11h-5z" />
              </svg>
            </button>
            <button
              classList={{ on: pvCols(p.card.id) === 2 }}
              aria-label="Two columns"
              data-tip="Previews in two columns"
              onClick={() => setPreviewCols(p.card.id, 2)}
            >
              <svg class="ico" viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">
                <path d="M2.5 2.5h4.5v11h-4.5zM9 2.5h4.5v11h-4.5z" />
              </svg>
            </button>
          </span>
          <button class="sbclr" data-tip="Close all previews" onClick={() => clearPreviews(p.card.id)}>
            Clear
          </button>
        </div>
      </Show>
      <Show when={sk() === null}>
        <div class="sbgone" data-drag>
          This board was deleted or can’t be read.
        </div>
      </Show>
      <Show
        when={titleOnly() && sk()}
        fallback={
          <div
            class="skel sbmap"
            data-drag
            innerHTML={html()}
            onPointerOver={over}
            onPointerLeave={() => setTip(null)}
            onPointerDown={() => setTip(null)}
          />
        }
      >
        <div class="sbonly" data-drag>
          <Icon name="boards" size={28} />
        </div>
      </Show>
      <Show when={fit() && !titleOnly()}>
        {/* 点开的块：描边 + 编号（和预览上的一样） */}
        <For each={open()}>
          {(id, i) => {
            const r = () => at(byId().get(id)!);
            return (
              <div
                class="sbpick"
                data-pick={id}
                data-export="strip"
                style={{ left: `${r().x}px`, top: `${r().y}px`, width: `${r().w}px`, height: `${r().h}px` }}
              >
                <i>{i() + 1}</i>
              </div>
            );
          }}
        </For>
        <Show when={byId().get(tip() ?? "")}>
          {(c) => {
            const r = () => at(c());
            return (
              <div
                class="sbtip"
                data-export="strip"
                style={{ left: `${Math.max(0, r().x)}px`, top: `${r().y + r().h + 6}px` }}
              >
                <Icon name={skelIcon(c())} size={11} />
                <span>{skelName(c())}</span>
              </div>
            );
          }}
        </Show>
      </Show>
    </>
  );
}
