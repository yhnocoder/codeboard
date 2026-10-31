// 子白板框：一张静态的缩略地图。名字和卡数在框外上方（大字）；框里是子白板真实的样子等比缩小：Section 是淡色区域（名字 + 卡数，字号固定），
// 卡是按真实位置、大小的块（Note 纸白、几道灰线代表字，代码卡带一条蓝灰的头，Text 一道线，图片画缩略图），箭头是细线。块上不写字，悬停显示标题。
// 地图拼成一段 SVG 一次放进去（不是每块一个组件）：拖别的卡、平移缩放都不碰它，只有骨架换了（宿主推来新的）、框改了大小才重新拼。
// 点一块：框外弹出那张卡的只读预览（cards/SubPreviews.tsx）；点开的块描边、带和预览一样的编号。双击框还是进子白板
import { createMemo, createSignal, For, Show } from "solid-js";
import { escHtml, mapFit, type BoardCard, type MapFit, type Skeleton, type SkelCard } from "@codeboard/core";
import { flows, placeOf, state } from "../state/store";
import { skels, FRAME_H, pvs, pvCols, clearPreviews, foldPreviews, setPreviewCols } from "../state/subboards";
import { assetSrc } from "../actions/web";
import { Icon } from "../ui/icons";
import { MarkView } from "./Card";

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
    return s && m && !titleOnly() ? mapHtml(s, m) : "";
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
      {/* 地图档时浮在框上面的名字（字号按 --iz 放大） */}
      <div class="sbfar">{p.card.title || sk()?.name || ""}</div>
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

const n1 = (v: number) => Math.round(v * 10) / 10;
/** 代码卡、Note 的几道线（长短轮着来，看着像字）；代码每三行缩进一行 */
const CODE_W = [0.5, 0.78, 0.64, 0.4, 0.7, 0.56],
  NOTE_W = [0.98, 0.92, 0.97, 0.7, 0.95, 0.88, 0.6];

/** 整张地图：一段 SVG（坐标是框里的像素，世界坐标）加上 Section 的名字（HTML，字号固定，骑在区域的上沿：区域里面留给卡）。只在骨架或框的大小变了时拼 */
function mapHtml(sk: Skeleton, m: MapFit): string {
  const X = (v: number) => n1(m.ox + v * m.s),
    Y = (v: number) => n1(m.oy + v * m.s),
    L = (v: number) => n1(v * m.s);
  const out: string[] = [];
  for (const s of sk.secs)
    out.push(
      `<rect class="sec${s.color ? ` c-${escHtml(s.color)}` : ""}" x="${X(s.x)}" y="${Y(s.y)}" width="${L(s.w)}" height="${L(s.h)}"/>`,
    );
  for (const [i, j] of sk.ln) {
    const A = sk.cards[i],
      B = sk.cards[j];
    const ax = A.x + A.w / 2,
      ay = A.y + A.h / 2,
      bx = B.x + B.w / 2,
      by = B.y + B.h / 2,
      horiz = Math.abs(bx - ax) > Math.abs(by - ay);
    const p1 = horiz ? [ax < bx ? A.x + A.w : A.x, ay] : [ax, ay < by ? A.y + A.h : A.y],
      p2 = horiz ? [ax < bx ? B.x : B.x + B.w, by] : [bx, ay < by ? B.y : B.y + B.h];
    const [x1, y1, x2, y2] = [X(p1[0]), Y(p1[1]), X(p2[0]), Y(p2[1])];
    const c = horiz
      ? `C${n1((x1 + x2) / 2)} ${y1} ${n1((x1 + x2) / 2)} ${y2}`
      : `C${x1} ${n1((y1 + y2) / 2)} ${x2} ${n1((y1 + y2) / 2)}`;
    out.push(`<path class="ln" d="M${x1} ${y1} ${c} ${x2} ${y2}"/>`);
  }
  for (const c of sk.cards) {
    const x = X(c.x),
      y = Y(c.y),
      w = Math.max(1, L(c.w)),
      h = Math.max(1, L(c.h));
    let inner = "";
    if (c.k === "image") {
      const src = c.img ? assetSrc(c.img) : undefined;
      inner = src
        ? `<image href="${escHtml(src)}" x="${x}" y="${y}" width="${w}" height="${h}" preserveAspectRatio="xMidYMid slice"/><rect class="im" x="${x}" y="${y}" width="${w}" height="${h}"/>`
        : `<rect class="imx" x="${x}" y="${y}" width="${w}" height="${h}"/>`;
    } else if (c.lk === "text") {
      // 一行放得下就是一道粗线（标题、短标签）；多行的正文按高度画满几道线，没有纸
      if (h < 9)
        inner = `<rect class="bar t" x="${x}" y="${n1(y + h / 2 - 1.2)}" width="${n1(w * 0.8)}" height="2.4"/>`;
      else
        for (let k = 0, yy = y + 2; yy + 2 < y + h && k < 60; k++, yy += 5)
          inner += `<rect class="bar" x="${x}" y="${n1(yy)}" width="${n1(w * NOTE_W[k % 7])}" height="1.6"/>`;
    } else if (c.lk === "mark") {
      for (let k = 0, yy = y + 2; k < 3 && yy + 2 < y + h; k++, yy += 5)
        inner += `<rect class="bar mk" x="${x}" y="${n1(yy)}" width="${n1(w * [0.9, 0.75, 0.5][k])}" height="1.8"/>`;
    } else if (c.lk === "box") {
      inner = `<rect class="bxo" x="${x}" y="${y}" width="${w}" height="${h}"/>`;
    } else {
      const code = c.k === "code" || c.k === "compare",
        hd = code ? Math.min(7, h / 3) : c.k === "web" ? Math.min(h * 0.4, 40) : 0;
      inner =
        `<rect class="bx" x="${x}" y="${y}" width="${w}" height="${h}"/>` +
        (hd ? `<rect class="hd" x="${x}" y="${y}" width="${w}" height="${n1(hd)}"/>` : "");
      const lx = n1(x + 4),
        lw = w - 8;
      let yy = y + hd + 4,
        n = 0;
      if (lw > 6) {
        if (c.k === "note" || c.k === "board") {
          inner += `<rect class="bar t" x="${lx}" y="${n1(yy)}" width="${n1(lw * 0.62)}" height="2.2"/>`;
          yy += 6;
        }
        while (yy + 2 < y + h - 4 && n < 40) {
          const ww = lw * (code ? CODE_W[n % 6] : NOTE_W[n % 7]);
          inner += `<rect class="bar" x="${n1(lx + (code && n % 3 === 1 ? 6 : 0))}" y="${n1(yy)}" width="${n1(ww)}" height="1.6"/>`;
          yy += 5;
          n++;
        }
      }
    }
    out.push(
      `<g class="c k-${c.k}${c.lk ? ` l-${c.lk}` : ""}" data-sub="${escHtml(c.id)}">${inner}<rect class="hit" x="${n1(x - 1)}" y="${n1(y - 1)}" width="${n1(w + 2)}" height="${n1(h + 2)}"/></g>`,
    );
  }
  const n = new Map<number, number>();
  for (const c of sk.cards) if (c.si !== undefined) n.set(c.si, (n.get(c.si) ?? 0) + 1);
  const labs = sk.secs.map((s, i) =>
    L(s.w) < 36
      ? ""
      : `<div class="sblab" style="left:${X(s.x) + 4}px;top:${Y(s.y) - 9}px;max-width:${L(s.w) - 8}px" title="${escHtml(s.t)}"><span>${escHtml(s.t || "Section")}</span><em>${n.get(i) ?? 0}</em></div>`,
  );
  return `<svg class="sbsvg" aria-hidden="true">${out.join("")}</svg>${labs.join("")}`;
}
