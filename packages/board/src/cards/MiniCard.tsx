// A card drawn read-only from its data alone, with the board's own card classes so each theme draws it as on the board: the
// Shelf's pictures (ui/ShelfPanel.tsx) and the preview of a card that is not drawn on this board (ui/pops/cardpeek.tsx: a card on
// another board or inside a sub-board, its data from the host's subCard). Nothing here reads the board's store
import { For, Show, createMemo, type JSX } from "solid-js";
import {
  cardTitle,
  codeGlyph,
  commonIndent,
  escHtml,
  fileCount,
  hiddenLang,
  isCode,
  isTextCard,
  mdHeading,
  mixedVersions,
  textSizeOf,
  versionLabel,
  type Board,
  type Card,
  type CodeCard,
  type SegView,
  type SubCard,
} from "@codeboard/core";
import { cardKindClass } from "../cardsel";
import { MdStatic } from "../ui/Md";
import { boxFill, hidesHeading } from "./notelook";
import { assetSrc } from "../actions/web";

/** 代码预览最多排几行（正文最高 ~170px，再多也看不见） */
const CODE_LINES = 16;
/** Lines of a code card drawn, at most (the card clips what does not fit) */
const MINI_LINES = 60;
/** What a card is drawn from: the card, a Compare's columns, its segments' highlighted lines; board = the board it is on, when
 *  that is this one (a title that names other cards) */
export type MiniData = { card: Card; cols?: Card[]; views: Record<string, SegView>; board?: Pick<Board, "cards"> };

/** A code card's lines as the board draws them (its gutter, the common indentation hidden), at most MINI_LINES */
function MiniCode(p: { c: CodeCard; views: Record<string, SegView> }) {
  const rows = createMemo(() => {
    const out: { no: number; html: string; text: string }[] = [];
    for (const s of p.c.segments) {
      const v = p.views[s.id];
      for (let i = 0; i < s.text.length && out.length < MINI_LINES; i++)
        out.push({ no: s.start + i, html: v?.html[i] ?? escHtml(s.text[i]), text: s.text[i] });
    }
    return out;
  });
  const ded = () => commonIndent(rows().map((r) => r.text));
  const digits = () => String(rows().at(-1)?.no ?? 0).length;
  return (
    <div class="code" style={{ "--nd": String(digits()) }}>
      <div class="gutter">
        <For each={rows()}>
          {(r, i) => (
            <span class="no" style={{ top: `calc(var(--code-pt) + ${i() * 20}px)` }}>
              {r.no}
            </span>
          )}
        </For>
      </div>
      <div class="src" classList={{ ded: !!ded() }} style={{ "--ded": ded() }}>
        <For each={rows()}>{(r) => <div class="l" innerHTML={r.html || "​"} />}</For>
      </div>
    </div>
  );
}

/** A code card's file and line (or its segments and files) and its version, as its header shows them */
function CodeFacts(p: { c: CodeCard }) {
  const s0 = () => p.c.segments[0];
  const free = () => s0()?.src.kind === "free";
  return (
    <Show when={!free()}>
      <span class="cpath">
        <span class="rw">
          <span class="rl">
            {p.c.segments.length > 1
              ? `${p.c.segments.length} segments${fileCount(p.c) > 1 ? ` · ${fileCount(p.c)} files` : ""}`
              : `${(s0()?.path ?? "").split("/").slice(-1)[0]}:${s0()?.start}${s0() && hiddenLang(s0()!) ? ` · ${hiddenLang(s0()!)}` : ""}`}
          </span>
        </span>
      </span>
      <span class="grow" />
      <span class="rev fold">
        <span class="rw">
          <span class="rl">{mixedVersions(p.c) ? "Mixed" : versionLabel(s0()?.version, true)}</span>
        </span>
      </span>
    </Show>
  );
}

/** Text and Box draw at their own size and fill, as Card.tsx sets them on the card */
const textVars = (k: Card): JSX.CSSProperties =>
  isTextCard(k)
    ? { "--tfs": `${textSizeOf(k)}px`, ...(k.look === "box" ? { "--fc": `var(--bf-${boxFill(k)})` } : {}) }
    : {};

/** A card's face as the board draws it, read-only */
function MiniBody(p: { d: MiniData }) {
  return (
    <>
      {(() => {
        const k = p.d.card;
        if (k.kind === "note")
          switch (k.look) {
            case "note":
              return (
                <>
                  <div class="chead">
                    <span class="kind">¶</span>
                    <span class="ctitle sys">{k.title || mdHeading(k.md) || "Note"}</span>
                  </div>
                  <MdStatic src={k.md} class={`nbody${hidesHeading(k) ? " hidehead" : ""}`} />
                </>
              );
            default:
              return <MdStatic src={k.md} class="tx tb st-body" />;
          }
        return (
          <>
            <div class="chead">
              <Show when={k.kind === "code"}>
                <span class="kind">{k.kind === "code" ? codeGlyph(k) : ""}</span>
              </Show>
              <span class="ctitle">{cardTitle(k, p.d.board)}</span>
              <Show when={k.kind === "code" && k}>{(c) => <CodeFacts c={c()} />}</Show>
            </div>
            <div class="carea">
              <div class="cbody">
                {k.kind === "code" ? (
                  <MiniCode c={k} views={p.d.views} />
                ) : (
                  <PvContent
                    data={{ card: k, cols: p.d.cols, views: p.d.views }}
                    t={k.title ?? ""}
                    lines={MINI_LINES}
                  />
                )}
              </div>
            </div>
          </>
        );
      })()}
    </>
  );
}

/** A whole card, read-only, placed by `style` (its box) */
export function MiniCard(p: { d: MiniData; style?: JSX.CSSProperties; ref?: (el: HTMLDivElement) => void }) {
  return (
    <div ref={p.ref} class={`card ${cardKindClass(p.d.card)}`} style={{ ...p.style, ...textVars(p.d.card) }}>
      <div class="cface">
        <MiniBody d={p.d} />
      </div>
    </div>
  );
}

/**
 * A card's content read-only, as a preview shows it (a sub-board's previews, SubPreviews.tsx, and the Shelf's cards that are not code); t = its title, an image's caption;
 * lines = how many lines of code at most (CODE_LINES)
 */
export function PvContent(p: { data: SubCard; t: string; lines?: number }) {
  const c = () => p.data.card;
  return (
    <>
      {(() => {
        const k = c();
        switch (k.kind) {
          case "note":
            return <MdStatic src={k.md} class={`pmd${hidesHeading(k) ? " hidehead" : ""}`} />;
          case "code":
            return <CodeLines card={k} views={p.data.views} lines={p.lines} />;
          case "compare":
            return (
              <For each={p.data.cols ?? []}>
                {(col) => (
                  <>
                    <div class="pcol">
                      {col.title || (isCode(col) ? col.segments[0]?.scope || col.segments[0]?.path : "") || "Column"}
                    </div>
                    {isCode(col) ? <CodeLines card={col} views={p.data.views} lines={p.lines} /> : null}
                  </>
                )}
              </For>
            );
          case "image":
            return (
              <>
                <img class="pimg" src={assetSrc(k.src)} alt={p.t} draggable={false} />
                <Show when={p.t}>
                  <div class="cap">{p.t}</div>
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
                <p>{p.t}</p>
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
function CodeLines(p: { card: Extract<Card, { kind: "code" }>; views: SubCard["views"]; lines?: number }) {
  const html = () => {
    const out: string[] = [];
    const most = p.lines ?? CODE_LINES;
    for (const s of p.card.segments) {
      const v = p.views[s.id];
      for (let i = 0; i < s.text.length && out.length < most; i++) out.push(v?.html[i] ?? escHtml(s.text[i]));
      if (out.length >= most) break;
    }
    return out.join("\n");
  };
  return <pre class="pcode" innerHTML={html()} />;
}
