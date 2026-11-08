import { For, Show, onMount, onCleanup, createMemo, createEffect, createSignal, on, untrack, batch } from "solid-js";
import { bounds, keepsLook, twinContent, type AlignOp } from "@codeboard/core";
import { state, rectOf, cardById, hostOf, placed, placeOf } from "../state/store";
import { sel } from "../state/selection";
import {
  cam,
  setViewport,
  viewTracked,
  camMoving,
  stillZ,
  camTarget,
  camTo,
  fitRect,
  flyingOut,
} from "../state/camera";
import { trackOffscreen } from "../state/cull";
import { trackSkeletons } from "../state/subboards";
import { guides, sizeHint, marquee, dragging, carried, dropTarget, walk, editing } from "../state/ui";
import { CardView } from "../cards/Card";
import { SubPreviews } from "../cards/SubPreviews";
import { AnimStrip } from "../ui/AnimStrip";
import { CanvasStickers } from "../stickers/Picker";
import { trackLinks, BlockPorts } from "./Links";
import { Traffic } from "./Traffic";
import { AltBoxes } from "./Labels";
import { SectionFrames, SectionLabels } from "./Sections";
import { frames } from "../state/sections";
import { canvasPointerDown, canvasWheel, canvasContextMenu } from "../interact";
import { bindShield } from "../ui/shield";
import { Icon } from "../ui/icons";
import * as A from "../actions";
import { boardMode } from "../state/mode";
import { kbd } from "../keymap";
import { observeResize, queueMeasure } from "../state/measure";
import { cardSel } from "../cardsel";
import { useMd } from "../md/context";
import { Summaries } from "./Summaries";
import { ShelfOutline } from "../ui/ShelfPanel";
import { cardsAsleep, cardsGone, cardsOpacity, detent } from "../state/summary";

/** The world-extent boxes (.wext, .cshield) reach this far beyond the cards and Sections, aligned to it: enough that a card
 *  nudged outward does not move them, and no more, since every tile of the box within ~3000 px of the viewport is a raster task
 *  at each re-raster of the world (see settle) */
const EXT = 512;

/** 正在写的字在屏幕上至少这么大（px） */
const READ_PX = 11;

/** Shown below this share of the device scale, a layer with the will-change hint keeps the scale it was rastered at when the
 *  hint is put back (Chromium: above it, between it and the device scale, it rasters at the device scale) */
const HINT_KEEPS = 0.25;
/** Below this zoom, above the summary cut, the world moves with no hint (see settle): under it Chromium would raster it at the
 *  device scale, over 2× the scale shown. Without the hint a zoom rasters the world at each frame's scale, which the Notes'
 *  prose drawn as bars below it (.world.greek) keeps cheap: drawn as text, the first frames of a pinch at 0.3–0.5 took 30–50 ms
 *  each on a 2× Mac on a board of dense Chinese Notes */
const HINT_MIN = 0.5;
/** The fade-in of the Notes' prose or bars after a switch (styles.css .world.greekfade, 220 ms) ends at its animationend; this
 *  takes the class off if that never comes (it starts only once what it shows is rastered, up to a second for dense prose) */
const GREEK_FADE_MAX = 2500;
/** A flight drops the hint (or rasters again under it) a little before it is shown at half the scale it was rastered at: the
 *  raster lags the camera by a frame or two at a flight's speed, and what is rastered under the hint then is drawn further out
 *  (at half, up to a sixth of a Fit's raster on an Ink Wash board was at over 2× the scale it was drawn at, 2–3 % at 1.8) */
const FLY_HALF = 1.8;

export function Canvas() {
  const md = useMd();
  let el!: HTMLDivElement, world!: HTMLDivElement;
  trackOffscreen();
  const links = trackLinks();
  const faded = createMemo(() => placed().filter((c) => !keepsLook(c)));
  const kept = createMemo(() => placed().filter(keepsLook));
  trackSkeletons();
  // 开始写 Note / Text 时字太小（缩得很小时按 N、双击）：镜头放大到看得清（最多 100%），卡放得下就整张放进来。退出编辑不缩回去
  createEffect(
    on(editing, (e) => {
      if (e?.kind !== "note") return;
      requestAnimationFrame(() => {
        const el = world.querySelector(`${cardSel(e.id)} :is(.nbody, .tx)`),
          f = cardById(e.id);
        if (!el || !f) return;
        const fs = parseFloat(getComputedStyle(el).fontSize),
          c = camTarget();
        if (!fs || fs * c.z >= READ_PX) return;
        const t = fitRect(rectOf(f.host), 1, Math.min(1, READ_PX / fs));
        camTo(t.x, t.y, t.z);
      });
    }),
  );
  // While the camera moves the world is scaled as a bitmap (styles.css .world: will-change; not below HINT_MIN, see below).
  // Stopped, .settle drops the hint so Chromium rasters the world again at the new scale, which makes the text crisp but is
  // not free: the compositor thread creates a raster task for every tile of the world in and around the viewport (hundreds, ~0.4 ms each without a GPU) and
  // the next commit waits for it: 6–17 ms at 75 % and above, 35–70 ms at 40–60 % on a board of dense Notes (their prose is
  // most of a tile's raster there), and more when it lands in the middle of a gesture. So the world is rastered again only
  // when it is magnified (zoomed in past the scale it was rastered at: scaled up, a bitmap is blurry) or minified past 2×
  // (scaled down it looks right, but the tiles at the old scale take many viewports of memory, and past about 8× Chromium
  // rasters again on its own, 135 ms, wherever that falls). A stop zoomed out a little, or back where it was, costs nothing.
  // .settle stays until the next move: taking it off again was a second commit that waited for the same raster.
  // Below HINT_MIN with the card level shown (just above the summary cut) a move does not put the hint back: Chromium would
  // raster the world at the device scale (see HINT_KEEPS: 1.0 at 0.3, 11× the pixels shown, 44× on a 2× screen), and every
  // tile a pan uncovers and every card a hover paints again with it, more than the GPU's tile memory holds: the tiles it cannot
  // keep were drawn as holes in the cards and images while the pointer moved. There a pan moves the world as it was last
  // rastered, a zoom rasters it at each frame's scale (at most the viewport's pixels), and a stop minified past 2× is rastered
  // again like any other. Pushing into the detent is not a stop (summary.ts: the camera is held at the cut while the gesture
  // goes on), so no re-raster lands under the switch's mist.
  // A camera flight that zooms out (Fit to Window, a reveal, the zoom keys) takes the hint off once it is shown at about half
  // its raster scale (FLY_HALF): under the hint every tile that comes into view on the way is rastered at the scale the flight
  // started from (Fit from 100 % on a board of 40 dense Notes: 43–77 viewports, 31–73 of them at over 2× the scale shown, the
  // links and cards layer at 1.0 while shown at 0.16–0.5), without it at the scale of each frame (35–40 viewports, 3–4 over
  // 2×). Chromium rasters a layer with the hint shown between a quarter of the device scale and the device scale at the device
  // scale, so putting the hint back there would raster the world at 1.0 again; shown below a quarter (HINT_KEEPS) the layer
  // keeps the scale it was rastered at. So from there on the flight takes the hint off for one frame each time the scale
  // about halves and puts it back, rastering the world a few times instead of at every frame (Fit from 100 % to 0.13: every
  // frame from 0.55 to 0.25, then at 0.25 and 0.14; on real study boards Fit to 0.22–0.24 rastered 14–47 viewports instead of
  // 39–66). A wheel, a drag or a fling that takes over puts the hint back (above HINT_MIN, see
  // above). Where a flight that put the hint back stops, the world is rastered once more at the scale it stopped at: what came into view under the hint (the summaries, laid out at
  // 1 / K and shown above a quarter) was rastered at the device scale
  const [settle, setSettle] = createSignal(false);
  const hintable = (z: number) => z >= HINT_MIN || cardsGone();
  // the hint back on above HINT_KEEPS, Chromium rasters the world at the device scale (1.0 here) at least
  const hint = () => {
    setSettle(false);
    if (cam.z > HINT_KEEPS) rasterZ = Math.max(rasterZ, 1);
  };
  let rasterZ = Math.max(cam.z, 1),
    moving = false,
    unhinted = false,
    rehinted = false,
    pulse = 0;
  createEffect(() => {
    const m = camMoving(),
      z = cam.z;
    untrack(() => {
      if (m) {
        if (!moving) {
          moving = true;
          unhinted = rehinted = false;
          pulse++;
        }
        const out = flyingOut();
        if (out && (unhinted || z < rasterZ / FLY_HALF)) {
          rasterZ = z;
          setSettle(true);
          if (z > HINT_KEEPS) unhinted = true;
          else {
            unhinted = false;
            rehinted = true;
            const k = ++pulse;
            requestAnimationFrame(() => k === pulse && setSettle(false));
          }
        } else if (unhinted && !out) {
          unhinted = false;
          if (hintable(z)) hint();
        } else if ((!out || !rehinted) && settle() && hintable(z)) hint();
        return;
      }
      if (!moving) return;
      moving = false;
      pulse++;
      if (z > rasterZ * 1.04 || z < rasterZ / 2 || rehinted) {
        rasterZ = z;
        setSettle(true);
      }
    });
  });
  // Zoomed out past Simplify Below (styles.css .world.greek): taken at a stop (stillZ), never in the middle of a zoom. A switch
  // with the cards shown fades what is swapped in (.greekfade). Into and out of the summary level it changes at once (the
  // cards are gone, or come back, anyway)
  const simple = createMemo(() => stillZ() < state.host.settings.simpleBelow && !cardsGone());
  const [greek, setGreek] = createSignal(simple());
  const [greekFade, setGreekFade] = createSignal(false);
  let fadeT: number | undefined;
  let restartF = 0;
  createEffect(
    on(
      [simple, cardsGone],
      ([g, gone], prev) => {
        cancelAnimationFrame(restartF);
        clearTimeout(fadeT);
        if (gone || prev?.[1]) {
          setGreekFade(false);
          return void setGreek(g);
        }
        // the swap and the fade-in go in one commit, so the fade starts when what is swapped in is rastered (the compositor
        // starts an animation when it first draws it); .greekfade comes off at its animationend (the timer only if that never
        // comes). A switch back during it: the class off now, and the swap with the fade a frame later, so it starts over
        const was = greekFade();
        setGreekFade(false);
        if (g === greek()) return;
        const go = () => {
          batch(() => {
            setGreek(g);
            setGreekFade(true);
          });
          fadeT = window.setTimeout(() => setGreekFade(false), GREEK_FADE_MAX);
        };
        if (was) restartF = requestAnimationFrame(go);
        else go();
      },
      { defer: true },
    ),
  );
  onCleanup(() => {
    cancelAnimationFrame(restartF);
    clearTimeout(fadeT);
  });
  // Without the hint a move of the world by a fraction of a device pixel rasters it again (its tiles are drawn at the new
  // offset): a trackpad pan or a fling at 0.34, 1.4 viewports a step. Settled, it moves by whole device pixels
  const px = (v: number) => {
    if (!settle()) return v;
    const d = window.devicePixelRatio || 1;
    return Math.round(v * d) / d;
  };
  // A lifted card, and what a Section drag carries, is a layer of its own with its raster scale fixed (styles.css .card.lift,
  // .carry: will-change). When the camera stops at another zoom in the middle of a drag, .relift takes the hint off for one
  // drawn frame and puts it back, so the card is rastered again at the new scale instead of staying blurry (or needlessly
  // sharp) until it is put down. Panning keeps stillZ
  const [relift, setRelift] = createSignal(false);
  const carrying = () => carried().cards.size + carried().sections.size > 0;
  const guideX = createMemo(() => guides().find((g) => g.axis === "x")),
    guideY = createMemo(() => guides().find((g) => g.axis === "y"));
  createEffect(
    on(
      stillZ,
      () => {
        if (!dragging().size && !carrying()) return;
        setRelift(true);
        requestAnimationFrame(() => requestAnimationFrame(() => setRelift(false)));
      },
      { defer: true },
    ),
  );
  // 打开白板后，世界层的 transform 要先变过一次，之后的平移才便宜：没变过时，Chromium 每帧都把整块世界层重新分层（实测每帧 40+ ms，
  // 变过一次以后 ~13 ms）。所以白板一加载好就悄悄动 0.01px 再放回，用户的第一段平移就不会卡
  createEffect(
    on(
      () => state.loaded,
      (ok) => {
        if (!ok || !world) return;
        requestAnimationFrame(() =>
          requestAnimationFrame(() => {
            world.style.translate = "0.01px 0";
            requestAnimationFrame(() => {
              world.style.translate = "";
            });
          }),
        );
      },
    ),
  );
  // 线的 SVG 后面紧跟一块空的、盖住整块白板的方框（.wext，不画东西）。线在所有卡下面，卡都压在线那个合成层上面，只能并进它（或者更上面的层）；
  // Chromium 合并时看两块范围拼起来空不空（稀疏就另起一层），线那层的范围只是线画到的地方，卡并不进去，相隔很远的卡彼此也并不了，
  // 结果几乎每张卡一个合成层（实测 74 层，CDP 的原因都是 Overlap；SVG 自己没有 will-change、动画、滤镜之类的原因）。
  // 这一块先并进线那层、把范围撑到整块白板，后面的卡就都并得进去：层数回到 25 层（Section 框还是各自一层）。
  // 放在最前面（Section 框前面）也行，但那样 Section 框、线、卡全挤进一个层，缩放、捏合的慢帧多。范围按卡和 Section 的外框往外留 EXT、对齐到 EXT 的整数倍，拖动中不重算
  const extentBox = () => {
    const [x, y, w, h] = extent().split(" ");
    return { left: `${x}px`, top: `${y}px`, width: `${w}px`, height: `${h}px` };
  };
  const extent = createMemo<string>((prev) => {
    if (prev && (dragging().size || carrying())) return prev;
    let x0 = 0,
      y0 = 0,
      x1 = 0,
      y1 = 0;
    const add = (r: { x: number; y: number; w: number; h: number }) => {
      x0 = Math.min(x0, r.x);
      y0 = Math.min(y0, r.y);
      x1 = Math.max(x1, r.x + r.w);
      y1 = Math.max(y1, r.y + r.h);
    };
    for (const c of placed()) add(rectOf(c));
    for (const r of frames().values()) add(r);
    x0 = Math.floor(x0 / EXT - 1) * EXT;
    y0 = Math.floor(y0 / EXT - 1) * EXT;
    x1 = Math.ceil(x1 / EXT + 1) * EXT;
    y1 = Math.ceil(y1 / EXT + 1) * EXT;
    return `${x0} ${y0} ${x1 - x0} ${y1 - y0}`;
  });
  onMount(() => {
    const ro = new ResizeObserver(() => setViewport(el.clientWidth, el.clientHeight));
    ro.observe(el);
    setViewport(el.clientWidth, el.clientHeight);
    el.addEventListener("wheel", canvasWheel, { passive: false });
    onCleanup(() => {
      ro.disconnect();
      el.removeEventListener("wheel", canvasWheel);
    });
  });
  return (
    <div
      ref={el}
      id="board"
      class="board"
      data-mode={boardMode()}
      classList={{
        walking: !!walk(),
        dragging: dragging().size > 0,
        relift: relift(),
        "img-drop": dropTarget()?.kind === "note",
      }}
      onPointerDown={canvasPointerDown}
      onContextMenu={(e) => canvasContextMenu(e, md)}
    >
      <div
        ref={world}
        class="world"
        classList={{
          moving: camMoving(),
          settle: settle(),
          greek: greek(),
          greekfade: greekFade(),
        }}
        onAnimationEnd={(e) => e.animationName === "greek-in" && setGreekFade(false)}
        style={{ transform: `translate(${px(cam.x)}px, ${px(cam.y)}px) scale(${cam.z})` }}
      >
        {/* the card level (zoomed out it is swapped out as one layer and stays under the summaries: state/summary.ts) */}
        <div
          class="lay cardlay"
          style={{ opacity: String(cardsOpacity()) }}
          classList={{ gone: cardsGone(), asleep: cardsAsleep() }}
        >
          <SectionFrames />
          <links.Layer bottom />
          <div class="wext" style={extentBox()} />
          <For each={faded()}>{(c) => <CardView card={c} />}</For>
          <Traffic ways={links.ways} />
          <links.Layer ports />
          <CanvasStickers />
          <SectionLabels />
          {/* 灰色备选：在所有卡上面、浮上来的线下面 */}
          <div class="alts">
            <AltBoxes />
          </div>
          <links.Layer top />
          <BlockPorts />
          {/* 子白板框外点开的预览：在卡和线上面 */}
          <SubPreviews />
          {/* the selected animated image's filmstrip, under it (md/anim.ts) */}
          <AnimStrip />
          {/* Walkthrough 的步数：卡上方的小号码（算出来的，不存；走过的卡不再走），在卡外面一层，变暗的卡也看得清 */}
          <Show when={walk()}>
            <WalkSteps />
          </Show>
          <Show when={A.pasteChip()}>{(p) => <PasteChip chip={p()} />}</Show>
          {/* the alignment guides: a layer of their own while a card or Section is dragged (styles.css .guides.live), so a
              guide that shows, moves or goes repaints only that layer, not the card level's; one element per axis (snapMove
              and snapResize give at most one each), kept while its guide stays, so an unchanged guide is not painted again */}
          <div class="guides" classList={{ live: dragging().size > 0 || carrying() }} data-export="strip">
            <Show when={guideX()}>
              {(g) => (
                <div
                  class="guide v"
                  style={{
                    left: `${g().at}px`,
                    top: `${g().from - 8}px`,
                    height: `${g().to - g().from + 16}px`,
                    "border-left-width": `${1 / cam.z}px`,
                  }}
                />
              )}
            </Show>
            <Show when={guideY()}>
              {(g) => (
                <div
                  class="guide h"
                  style={{
                    top: `${g().at}px`,
                    left: `${g().from - 8}px`,
                    width: `${g().to - g().from + 16}px`,
                    "border-top-width": `${1 / cam.z}px`,
                  }}
                />
              )}
            </Show>
            <Show when={sizeHint()}>
              {(h) => (
                <div
                  class="ghint"
                  style={{ left: `${h().x}px`, top: `${h().y}px`, transform: `translate(-50%, 0) scale(${1 / cam.z})` }}
                >
                  {h().text}
                </div>
              )}
            </Show>
            <DropHint />
          </div>
        </div>
        {/* swapped out, the card level is not hit: a shield over its whole extent takes the pointer (styles.css .cshield) */}
        <Show when={cardsGone()}>
          <div class="cshield" style={extentBox()} />
        </Show>
        {/* sub-board frames and Free Text: never summarized, they stay as they are over the summary level (Marks go with the cards) */}
        <div class="lay keeplay">
          <For each={kept()}>{(c) => <CardView card={c} />}</For>
        </div>
        <Summaries />
        {/* a Shelf row dragged over the board: where it will land (ui/ShelfPanel.tsx) */}
        <ShelfOutline />
      </div>
      {/* the detent at the summary cut (state/summary.ts detent; styles.css .cutmist …): a mist in the board's colour rising from
          the bottom edge by the push (a viewport-tall layer scaled up from the bottom), past 1 covering the board for the
          switch; a vermilion line along the bottom filling with the push; the seal naming the level the push goes to. All in
          the viewport, over the world: transform and opacity only */}
      <div
        class="cutmist"
        classList={{ on: detent().mist > 0 }}
        style={{ transform: `scaleY(${detent().mist.toFixed(4)})` }}
      />
      <div class="cutline" classList={{ on: detent().line > 0 }}>
        <i style={{ transform: `scaleX(${detent().line.toFixed(3)})` }} />
      </div>
      <div class="cutseal" classList={{ on: detent().seal }}>
        {detent().to === 1 ? "Summary" : "Detail"}
      </div>
      {/* ui/shield.ts：滚轮平移、缩放的手势里盖在世界层上，命中测试不用把世界层里的东西一个个问过去 */}
      <div ref={bindShield} class="pshield" />
      <Show when={marquee()}>
        {(m) => (
          <div
            class="marquee"
            style={{
              left: `${m().x}px`,
              top: `${m().y}px`,
              width: `${m().w}px`,
              height: `${m().h}px`,
              display: "block",
            }}
          />
        )}
      </Show>
      <AlignBar />
      <Show when={!placed().length && state.loaded}>
        <EmptyHint />
      </Show>
    </div>
  );
}

function WalkSteps() {
  const items = createMemo(() => [...(A.walkSteps() ?? new Map<string, number>()).entries()]);
  const cur = () => {
    const w = walk();
    return w ? hostOf(w.order[w.i]) : undefined;
  };
  // 字号跟着镜头停下后的缩放反向放大一点（镜头动的时候不重算）
  const k = () => Math.max(1, 0.9 / stillZ());
  return (
    <div class="wsteps" data-export="strip">
      <For each={items()}>
        {([id, n]) => {
          const r = () => rectOf(id);
          return (
            <span
              class="wstep"
              classList={{ cur: cur() === id }}
              data-card={id}
              style={{ left: `${r().x}px`, top: `${r().y - 6}px`, transform: `translateY(-100%) scale(${k()})` }}
            >
              {n}
            </span>
          );
        }}
      </For>
    </div>
  );
}

/**
 * 粘贴 / ⌘D 出来的副本右下角：Copy ✓ | Reference。副本挪了、改了（选这两个本身的修改不算）、点了别处就收起；大小不随缩放
 */
function PasteChip(p: { chip: { pairs: [string, string][]; ref: boolean } }) {
  const ids = () => p.chip.pairs.map(([id]) => id);
  const box = createMemo(() =>
    bounds(
      ids()
        .filter((id) => cardById(id))
        .map((id) => rectOf(id)),
    ),
  );
  // 副本的摆放和内容（段 id 不算：Reference 换成原卡的段）
  const key = () =>
    ids()
      .map((id) => {
        const c = cardById(id)?.card,
          q = placeOf(id);
        return c ? `${q.x},${q.y},${q.w}|${twinContent(c).replace(/"id":"[^"]*"/g, "")}` : "";
      })
      .join("\n");
  let was = key(),
    choosing = false;
  createEffect(
    on(
      key,
      (k) => {
        if (k !== was && !choosing) A.closeChip();
      },
      { defer: true },
    ),
  );
  const choose = (ref: boolean) => {
    choosing = true;
    A.pasteAs(ref);
    choosing = false;
    was = key();
  };
  onMount(() => {
    const away = (e: PointerEvent) => {
      if (!(e.target as Element | null)?.closest?.(".pastechip")) A.closeChip();
    };
    window.addEventListener("pointerdown", away, true);
    onCleanup(() => window.removeEventListener("pointerdown", away, true));
  });
  return (
    <Show when={box()}>
      {(r) => (
        <div
          class="pill pastechip"
          data-export="strip"
          role="group"
          aria-label="Paste as"
          style={{
            left: `${r().x + r().w}px`,
            top: `${r().y + r().h + 8}px`,
            transform: `scale(${1 / cam.z}) translateX(-100%)`,
          }}
          onPointerDown={(e) => e.stopPropagation()}
          onPointerEnter={() => A.armChip(true)}
          onPointerLeave={() => A.armChip()}
        >
          <button
            class="tbtn"
            classList={{ on: !p.chip.ref }}
            data-tip="An independent copy"
            onClick={() => choose(false)}
          >
            Copy
            <Show when={!p.chip.ref}>
              <Icon name="check" size={12} />
            </Show>
          </button>
          <span class="sep" />
          <button
            class="tbtn"
            classList={{ on: p.chip.ref }}
            data-tip="The same card in two places: editing one changes the other"
            onClick={() => choose(true)}
          >
            <Icon name="link" size={12} />
            Reference
            <Show when={p.chip.ref}>
              <Icon name="check" size={12} />
            </Show>
          </button>
        </div>
      )}
    </Show>
  );
}

/** 拖动中的提示：Release to merge / Release to add as Sidenote */
function DropHint() {
  const d = () => dropTarget();
  const r = createMemo(() => {
    const t = d();
    return t && t.card ? rectOf(cardById(t.card)!.host) : null;
  });
  return (
    <Show when={d() && r() && (d()!.kind === "merge" ? d()!.armed : d()!.kind === "line" && dragging().size > 0)}>
      <div
        class="drophint"
        data-export="strip"
        style={{
          left: `${r()!.x + r()!.w / 2}px`,
          top: `${r()!.y - 8}px`,
          transform: `translate(-50%, -100%) scale(${1 / cam.z})`,
        }}
      >
        {d()!.kind === "merge"
          ? "Release to merge"
          : [...dragging()].some((id) => cardById(id)?.card.kind === "note")
            ? "Release to add as Sidenote"
            : "Release to add as Code Sidenote"}
      </div>
    </Show>
  );
}

const AL: { op: AlignOp; icon: string; tip: string }[] = [
  { op: "left", icon: "alignL", tip: "Align Left" },
  { op: "hcenter", icon: "alignC", tip: "Align Centre" },
  { op: "right", icon: "alignR", tip: "Align Right" },
  { op: "top", icon: "alignT", tip: "Align Top" },
  { op: "bottom", icon: "alignB", tip: "Align Bottom" },
  { op: "hdist", icon: "distH", tip: "Distribute Horizontally" },
  { op: "vdist", icon: "distV", tip: "Distribute Vertically" },
];

/** 工具条的高度（4 + 30 + 4）：上面放不下时翻到选中的卡下面 */
const BAR_H = 38;
/** 工具条离视野左右两边至少留这么多 */
const BAR_PAD = 8;
/** 上下各让出的高度：顶上是白板的标题栏；底下是工具栏和右下角的缩放（bottom 12 + 高 36），再留 BAR_PAD */
const CHROME_Y = 56;

/** 选中 ≥2 张卡时浮在上方的工具条：Create Section、Create Sub-board、Tidy Up，··· 里是对齐和分布 */
function AlignBar() {
  const rs = createMemo(
    () =>
      sel.cards
        .map((id) => {
          const f = cardById(id);
          return f ? { id: f.host.id, ...rectOf(f.host) } : null;
        })
        .filter(Boolean) as { id: string; x: number; y: number; w: number; h: number }[],
  );
  const box = createMemo(() => bounds(rs()));
  const shown = () => rs().length >= 2 && dragging().size === 0 && !walk();
  // 工具条宽度只随按钮变，量一次存下来：镜头每动一帧都要按它夹进视野，不能每帧去读 DOM
  const [barW, setBarW] = createSignal(0);
  // 上方：卡的上边往上 12px；顶上 CHROME_Y 内（白板的标题栏）放不下就放到卡的下边下面。
  // 再整条夹进视野（左右留 BAR_PAD，上下让开白板自己的工具栏）：靠边时平移进来，而不是让绝对定位的盒子缩到剩下的宽度、按钮文字折行
  const pos = () => {
    const b = box()!,
      v = viewTracked(),
      w = barW();
    const cx = b.x * cam.z + cam.x + (b.w * cam.z) / 2,
      top = b.y * cam.z + cam.y - 12 - BAR_H;
    const y = top >= CHROME_Y ? top : (b.y + b.h) * cam.z + cam.y + 12;
    // 取整：落在半个像素上图标会发糊
    return {
      x: Math.round(Math.max(BAR_PAD, Math.min(cx - w / 2, v.w - BAR_PAD - w))),
      y: Math.max(CHROME_Y, Math.min(y, v.h - CHROME_Y - BAR_H)),
    };
  };
  const [more, setMore] = createSignal(false);
  let el: HTMLDivElement | undefined;
  const track = (e: HTMLDivElement) => {
    el = e;
    const off = observeResize(e, () =>
      queueMeasure(e, () => {
        const w = e.offsetWidth;
        return () => setBarW(w);
      }),
    );
    onCleanup(off);
  };
  createEffect(
    on(
      () => sel.cards.join(" "),
      () => setMore(false),
      { defer: true },
    ),
  );
  createEffect(
    on(shown, (s) => {
      if (!s) setMore(false);
    }),
  );
  createEffect(() => {
    if (!more()) return;
    const down = (e: PointerEvent) => {
      if (!el?.contains(e.target as Node)) setMore(false);
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        setMore(false);
      }
    };
    document.addEventListener("pointerdown", down, true);
    document.addEventListener("keydown", key, true);
    onCleanup(() => {
      document.removeEventListener("pointerdown", down, true);
      document.removeEventListener("keydown", key, true);
    });
  });
  const run = (op: AlignOp) => A.alignCards(rs(), op);
  const tip = (label: string, id?: string) => {
    const k = id && kbd(id);
    return k ? `${label} (${k})` : label;
  };
  return (
    <Show when={shown()}>
      <div ref={track} class="alignbar pill show" data-nodrag style={{ left: `${pos().x}px`, top: `${pos().y}px` }}>
        <button
          class="tbtn"
          data-tip="Create Section"
          onClick={() => {
            setMore(false);
            A.moveToNewSection();
          }}
        >
          <Icon name="newSection" />
          Create Section
        </button>
        <button
          class="tbtn"
          data-tip={tip("Create Sub-board", "turnIntoBoard")}
          onClick={() => {
            setMore(false);
            void A.turnIntoBoard();
          }}
        >
          <Icon name="subBoard" />
          Create Sub-board
        </button>
        <button
          class="tbtn"
          data-tip={tip("Tidy Up", "tidyUp")}
          onClick={() => {
            setMore(false);
            void A.tidyUp();
          }}
        >
          <Icon name="tidy" />
          Tidy Up
        </button>
        <span class="sep" />
        <button
          class="ib"
          classList={{ on: more() }}
          aria-label="More"
          aria-haspopup="menu"
          aria-expanded={more()}
          data-tip={more() ? undefined : "More"}
          onClick={() => setMore(!more())}
        >
          <Icon name="more" />
        </button>
        <div class="alignmore" classList={{ open: more() }} role="menu" aria-label="Align and Distribute">
          <div class="t">Align</div>
          <For each={AL.slice(0, 5)}>
            {(a) => (
              <button
                class="ib"
                role="menuitem"
                aria-label={a.tip}
                data-tip={a.tip}
                tabIndex={more() ? 0 : -1}
                onClick={() => run(a.op)}
              >
                <Icon name={a.icon} />
              </button>
            )}
          </For>
          <div class="t">Distribute</div>
          <For each={AL.slice(5)}>
            {(a) => (
              <button
                class="ib"
                role="menuitem"
                aria-label={a.tip}
                data-tip={a.tip}
                tabIndex={more() ? 0 : -1}
                onClick={() => run(a.op)}
              >
                <Icon name={a.icon} />
              </button>
            )}
          </For>
        </div>
      </div>
    </Show>
  );
}

function EmptyHint() {
  return (
    <div class="emptyhint">
      <div class="eh-t">This board is empty</div>
      <div class="eh-d">
        In the editor, put the cursor in a function and press <kbd>{A.K.alt}B</kbd>.<br />
        Or press <kbd>{A.K.mod}K</kbd> to search for a function, or <kbd>{A.K.mod}V</kbd> to paste code.
      </div>
    </div>
  );
}
