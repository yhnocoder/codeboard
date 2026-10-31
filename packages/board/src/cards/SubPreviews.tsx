// 子白板框外点开的预览（state/subboards.ts 管点开了哪些、怎么摆）：不是白板，是一张张只读的卡：Note 按 Markdown 排好，代码卡是高亮的代码，
// 图片是图加图注。都不滚：正文最高 ~170px，放不下的渐隐。右边最多完整展开 3 张，多的是框下面的一行标题：点一下原地临时展开（浮在下面几行上面，
// 点别处收回），拖到右边就展开在落下的位置（右边最下面那张收成标题）；右边展开着的也能拖到下面收成标题。悬停一张，虚线连到地图上它那一块。
// 摆在世界坐标里（跟着框走，框挪动、改大小时跟着重摆），预览不进撤销、不存盘、不进导出
import { createEffect, createMemo, createSignal, For, onCleanup, Show } from "solid-js";
import { createStore } from "solid-js/store";
import { escHtml, isCode, type BoardCard, type Card, type SkelCard, type SubCard } from "@codeboard/core";
import { observeResize } from "@yhnocoder/markdown/ui";
import { cam } from "../state/camera";
import { track } from "../gesture";
import {
  frames,
  skels,
  pvs,
  pvPeek,
  setPvPeek,
  pvHot,
  setPvHot,
  pvCols,
  pvLayout,
  pvObstacles,
  frameRect,
  blockRect,
  subCard,
  togglePreview,
  dropRight,
  dropTitles,
  PV_W,
  PV_GAP,
  TIT_W,
  TIT_H,
  TIT_GAP,
  type PvBox,
} from "../state/subboards";
import { assetSrc } from "../actions/web";
import { Icon } from "../ui/icons";
import { MdStatic } from "../ui/Md";
import { skelIcon, skelName } from "./BoardBody";
import { hidesHeading } from "./NoteBody";

/** 拖动多远（屏幕 px）才算拖，不算点 */
const DRAG_SLOP = 4;
/** 代码预览最多排几行（正文最高 ~170px，再多也看不见） */
const CODE_LINES = 16;

export function SubPreviews() {
  const list = createMemo(() => frames().filter((f) => pvs[f.id]?.open.length && skels[f.board]));
  // 点别处：临时展开的标题收回去
  createEffect(() => {
    const pk = pvPeek();
    if (!pk) return;
    const down = (e: PointerEvent) => {
      if (!(e.target as Element | null)?.closest?.(`.sbpv[data-f="${pk.f}"][data-pv="${pk.id}"]`)) setPvPeek(null);
    };
    window.addEventListener("pointerdown", down, true);
    onCleanup(() => window.removeEventListener("pointerdown", down, true));
  });
  return <For each={list()}>{(f) => <FramePreviews frame={f} />}</For>;
}

type Drag = { id: string; x: number; y: number; zone: "right" | "tit" | null; fromRight: boolean };

function FramePreviews(p: { frame: BoardCard }) {
  const fid = () => p.frame.id;
  const sk = () => skels[p.frame.board]!;
  const byId = createMemo(() => new Map(sk().cards.map((c) => [c.id, c])));
  const pv = () => pvs[fid()];
  const ids = () => pv().open.filter((id) => byId().has(id));
  // 每张展开后的高（量到的；标题行也量它展开后的，拖到右边、临时展开时直接按它摆）
  const [hs, setHs] = createStore<Record<string, number>>({});
  const hOf = (id: string) => hs[id] ?? 120;
  const [drag, setDrag] = createSignal<Drag | null>(null);
  const peek = () => {
    const k = pvPeek();
    return k?.f === fid() ? k.id : undefined;
  };
  const rect = () => frameRect(fid());
  // 别的卡在哪（标题行不盖它们）：只有开着预览的框才算
  const obstacles = createMemo(() => (pv().tit.length ? pvObstacles(fid()) : []));
  const lay = createMemo(() => pvLayout(rect(), pv(), pvCols(fid()), hOf, peek(), obstacles()));
  const layFor = (exp: string[]) => pvLayout(rect(), { exp, tit: [] }, pvCols(fid()), hOf).boxes;
  const isTit = (id: string) => pv().tit.includes(id);

  const down = (e: PointerEvent, id: string) => {
    if (e.button !== 0 || (e.target as Element).closest("button")) return;
    e.preventDefault();
    e.stopPropagation();
    const box = lay().boxes.get(id);
    if (!box) return;
    const fromRight = !isTit(id);
    const zoneOf = (x: number, y: number): Drag["zone"] => {
      const l = lay(),
        cx = x + (fromRight ? PV_W : TIT_W) / 2,
        t = l.titles;
      if (fromRight && y + TIT_H / 2 > t.y - PV_GAP && cx > t.x - PV_GAP && cx < t.x + t.w + PV_GAP) return "tit";
      return cx > l.right.x - PV_GAP ? "right" : null;
    };
    let started = false;
    track(
      e,
      (ev) => {
        if (!started) {
          started = true;
          if (peek()) setPvPeek(null);
        }
        const x = box.x + (ev.clientX - e.clientX) / cam.z,
          y = box.y + (ev.clientY - e.clientY) / cam.z;
        setDrag({ id, x, y, zone: zoneOf(x, y), fromRight });
      },
      (ev, moved) => {
        const d = drag();
        setDrag(null);
        if (!moved) {
          if (!fromRight) setPvPeek(peek() === id ? null : { f: fid(), id });
          return;
        }
        if (!d) return;
        if (d.zone === "right") dropRight(fid(), id, d.y, layFor);
        else if (d.zone === "tit") {
          const l = lay(),
            cx = d.x + TIT_W / 2 - l.titles.x,
            cy = d.y + TIT_H / 2 - l.titles.y;
          dropTitles(
            fid(),
            id,
            Math.max(0, Math.floor(cy / (TIT_H + TIT_GAP))),
            Math.max(0, Math.min(l.per - 1, Math.floor(cx / (TIT_W + PV_GAP)))),
            l.per,
          );
        }
      },
      DRAG_SLOP,
      () => setDrag(null),
    );
  };

  // 悬停的预览连到它那一块：块的中心 → 预览的标题行（右边的从左边出，标题行从上边出）
  const line = createMemo(() => {
    const h = pvHot();
    if (!h || h.f !== fid() || pv().fold || drag()) return null;
    const r = blockRect(fid(), h.id),
      b = lay().boxes.get(h.id);
    if (!r || !b) return null;
    const x1 = r.x + r.w / 2,
      y1 = r.y + r.h / 2,
      tit = isTit(h.id);
    const x2 = b.x + (tit ? 20 : 0),
      y2 = b.y + (tit ? 0 : 15);
    const c = tit ? `C${x1} ${y1 + 50} ${x2} ${y2 - 50}` : `C${x1 + 60} ${y1} ${x2 - 40} ${y2}`;
    return { x1, y1, d: `M${x1} ${y1} ${c} ${x2} ${y2}` };
  });

  return (
    <div class="sbpvs" classList={{ folded: pv().fold }} data-nodrag data-export="strip" data-f={fid()}>
      <Show when={drag()}>
        {(d) => {
          const l = () => lay();
          return (
            <>
              <div
                class="sbdrop"
                classList={{ on: d().zone === "right" }}
                style={box({ x: l().right.x - 6, y: l().right.y - 6, w: l().right.w + 12, h: l().right.h + 12 })}
              />
              <Show when={d().fromRight}>
                <div
                  class="sbdrop"
                  classList={{ on: d().zone === "tit" }}
                  style={box({ x: l().titles.x - 6, y: l().titles.y - 6, w: l().titles.w + 12, h: l().titles.h + 12 })}
                />
              </Show>
            </>
          );
        }}
      </Show>
      <For each={ids()}>
        {(id) => {
          const c = () => byId().get(id)!;
          const b = (): PvBox => {
            const d = drag();
            const r = lay().boxes.get(id)!;
            return d?.id === id ? { ...r, x: d.x, y: d.y } : r;
          };
          const tit = () => isTit(id);
          return (
            <div
              class={`sbpv k-${c().k}`}
              data-f={fid()}
              data-pv={id}
              classList={{
                mini: tit() && peek() !== id,
                tit: tit(),
                peek: tit() && peek() === id,
                drag: drag()?.id === id,
                hot: pvHot()?.f === fid() && pvHot()!.id === id,
              }}
              style={{ left: `${b().x}px`, top: `${b().y}px`, width: `${b().w}px` }}
              onPointerEnter={() => setPvHot({ f: fid(), id })}
              onPointerLeave={() => {
                if (pvHot()?.id === id) setPvHot(null);
              }}
            >
              <PvCard
                frame={fid()}
                board={p.frame.board}
                sk={c()}
                n={pv().open.indexOf(id) + 1}
                onDown={(e) => down(e, id)}
                onHeight={(h) => setHs(id, h)}
              />
            </div>
          );
        }}
      </For>
      <Show when={line()}>
        {(l) => (
          <svg class="sbpvl" width="1" height="1" aria-hidden="true">
            <circle cx={l().x1} cy={l().y1} r="2.5" />
            <path d={l().d} />
          </svg>
        )}
      </Show>
    </div>
  );
}

const box = (r: { x: number; y: number; w: number; h: number }) => ({
  left: `${r.x}px`,
  top: `${r.y}px`,
  width: `${r.w}px`,
  height: `${r.h}px`,
});

/** 一张预览：标题行（编号、种类、名字、关掉）+ 正文（最高 ~170px，放不下渐隐）。onHeight = 展开后的高（标题行的时候也量，正文只是被裁掉） */
function PvCard(p: {
  frame: string;
  board: string;
  sk: SkelCard;
  n: number;
  onDown: (e: PointerEvent) => void;
  onHeight: (h: number) => void;
}) {
  const d = () => subCard(p.board, p.sk.id);
  const [cut, setCut] = createSignal(false);
  let inner!: HTMLDivElement, body!: HTMLDivElement;
  const measure = () => {
    p.onHeight(inner.offsetHeight);
    setCut(body.scrollHeight > body.clientHeight + 2);
  };
  createEffect(() => {
    const off = observeResize(inner, measure);
    const off2 = observeResize(body, measure);
    onCleanup(() => {
      off();
      off2();
    });
  });
  return (
    <div ref={inner} class="pvin">
      <div class="ph" onPointerDown={(e) => p.onDown(e)}>
        <i>{p.n}</i>
        <Icon name={skelIcon(p.sk)} size={11} />
        <span classList={{ mono: p.sk.k === "code" }} title={skelName(p.sk)}>
          {skelName(p.sk)}
        </span>
        <button
          class="x"
          aria-label="Close this preview"
          data-tip="Close"
          onClick={() => togglePreview(p.frame, p.sk.id)}
        >
          <Icon name="close" size={10} />
        </button>
      </div>
      <div ref={body} class="pb" classList={{ cut: cut() }}>
        <Show
          when={d()}
          fallback={<div class="pload">{d() === null ? "This card is no longer on the board." : "Loading…"}</div>}
        >
          {(r) => <PvContent data={r()} sk={p.sk} />}
        </Show>
      </div>
    </div>
  );
}

function PvContent(p: { data: SubCard; sk: SkelCard }) {
  const c = () => p.data.card;
  return (
    <>
      {(() => {
        const k = c();
        switch (k.kind) {
          case "note":
            return <MdStatic src={k.md} class={`pmd${hidesHeading(k) ? " hidehead" : ""}`} />;
          case "code":
            return <CodeLines card={k} views={p.data.views} />;
          case "compare":
            return (
              <For each={p.data.cols ?? []}>
                {(col) => (
                  <>
                    <div class="pcol">
                      {col.title || (isCode(col) ? col.segments[0]?.scope || col.segments[0]?.path : "") || "Column"}
                    </div>
                    {isCode(col) ? <CodeLines card={col} views={p.data.views} /> : null}
                  </>
                )}
              </For>
            );
          case "image":
            return (
              <>
                <img class="pimg" src={assetSrc(k.src)} alt={p.sk.t} draggable={false} />
                <Show when={p.sk.t}>
                  <div class="cap">{p.sk.t}</div>
                </Show>
              </>
            );
          case "web":
            return (
              <div class="pweb">
                <b>{k.meta?.title || k.url}</b>
                <Show when={k.meta?.desc}>
                  <p>{k.meta!.desc}</p>
                </Show>
                <small>{k.meta?.site || k.url}</small>
              </div>
            );
          case "links":
            return (
              <ul class="plinks">
                <For each={k.items}>{(it) => <li>{it.title || it.meta?.title || it.url}</li>}</For>
              </ul>
            );
          case "board":
            return (
              <div class="pweb">
                <b>Sub-board</b>
                <p>{p.sk.t}</p>
              </div>
            );
          default:
            return null;
        }
      })()}
    </>
  );
}

/** 代码卡的前几行，按宿主给的高亮（没有就是原文） */
function CodeLines(p: { card: Extract<Card, { kind: "code" }>; views: SubCard["views"] }) {
  const html = () => {
    const out: string[] = [];
    for (const s of p.card.segments) {
      const v = p.views[s.id];
      for (let i = 0; i < s.text.length && out.length < CODE_LINES; i++) out.push(v?.html[i] ?? escHtml(s.text[i]));
      if (out.length >= CODE_LINES) break;
    }
    return out.join("\n");
  };
  return <pre class="pcode" innerHTML={html()} />;
}
