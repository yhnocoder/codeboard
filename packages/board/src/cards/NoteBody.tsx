import { For, Match, Show, Switch, createEffect, createMemo, createSignal, on } from "solid-js";
import { mdHeading, BOX_FILLS, HAND_COLORS, type NoteCard } from "@codeboard/core";
import { state, isSel, sel, placeOf } from "../state/store";
import { editing } from "../state/ui";
import { reduceMotion } from "../state/camera";
import { Editable } from "../ui/Editable";
import { Icon } from "../ui/icons";
import * as A from "../actions";
import { below } from "../ui/Menu";

/**
 * 卡头的名字就是 Markdown 开头的标题时，正文里藏起那一行（正文元素加 hidehead，styles.css 藏掉第一个标题）：没自己起名字、开头是标题、
 * 设置 noteHeadingInBody 没开。heading = mdHeading(md)（Note 卡里按 md 缓存着）。子白板预览的 Note 也照这一条（cards/SubPreviews.tsx）
 */
export const hidesHeading = (c: NoteCard, heading = c.look === "note" ? mdHeading(c.md) : "") => !c.title && !!heading && !state.host.settings.noteHeadingInBody;

export function NoteBody(p: { card: NoteCard }) {
  const c = () => p.card;
  // 卡头：用户改过的名字 → Markdown 开头的标题 → Note。只在 md 变了时重算（只看第一行非空的）
  const heading = createMemo(() => (c().look === "note" ? mdHeading(c().md) : ""));
  // 卡头的名字就是开头的标题时，正文里不再显示它（设置 noteHeadingInBody 可以留着）：只是显示上藏起来，Markdown 里还在，编辑时照常出现。
  // 编辑时整行卡头收起（folded，··· 留在右上角），标题从正文上沿滑出来，卡片高度不变（foldHeader）；退出时反过来，滑回去的那一会儿 sliding 让它先别藏
  const hideHead = () => hidesHeading(c(), heading());
  const [sliding, setSliding] = createSignal(false);
  const [folded, setFolded] = createSignal(false);
  const isEditing = () => editing()?.kind === "note" && editing()?.id === c().id;
  createEffect(on(isEditing, (now, was) => {
    if (was === undefined || now === was || (now && !hideHead()) || (!now && !folded())) return;
    if (!now) setSliding(true);
    queueMicrotask(() => foldHeader(c().id, now, setFolded, () => setSliding(false)));
  }));
  return (
    <Switch fallback={
      <Editable class={`tx st-${c().size ?? "body"}`} kind="note" id={c().id} value={c().md} multiline md placeholder="Type something…"
        style={c().bold ? { "font-weight": 650 } : undefined} onCommit={(v) => A.setNoteText(c().id, v)} />
    }>
      {/* Mark：手写字，统一字号，颜色在卡上（--hc） */}
      <Match when={c().look === "mark"}>
        <Editable class="tx hand" kind="note" id={c().id} value={c().md} multiline md placeholder="Write a mark…" onCommit={(v) => A.setNoteText(c().id, v)} />
      </Match>
      <Match when={c().look === "box"}>
        <Editable class="tx bx" kind="note" id={c().id} value={c().md} multiline md placeholder="Type…" onCommit={(v) => A.setNoteText(c().id, v)} />
      </Match>
      <Match when={c().look === "note"}>
      <div class="chead" classList={{ fold: folded() }} data-drag>
        <Show when={placeOf(c().id).locked}><button class="lockb" data-tip="Unlock" data-nodrag onClick={() => A.toggleLock([c().id])}><Icon name="lock" /></button></Show>
        <span class="kind">¶</span><span class="ctitle sys" classList={{ untitled: !c().title && !heading() }}>{c().title || heading() || "Note"}</span><span class="grow" />
        <button class="ib" aria-label="Note Menu" data-tip="More Actions" data-nodrag onClick={(e) => A.cardMenu(c().id, ...below(e.currentTarget))}><Icon name="more" /></button>
      </div>
      <Editable class={`nbody${hideHead() && !sliding() ? " hidehead" : ""}${folded() ? " fold" : ""}`} kind="note" id={c().id} value={c().md} multiline md placeholder="Write a note… Markdown and $math$ work" onCommit={(v) => A.setNoteText(c().id, v)} />
      </Match>
    </Switch>
  );
}

const HEADS = ":is(h1, h2, h3, h4, h5, h6):first-child";
/** 标题这一块（自己的高 + 下边距），按卡片自己的像素算（画布缩放了也一样；offsetHeight 取整会差零点几） */
const block = (e: HTMLElement) => { const r = e.getBoundingClientRect(); return r.height * (e.offsetWidth / r.width || 1) + parseFloat(getComputedStyle(e).marginBottom); };
/**
 * 开头标题就是卡头名字的 Note 进出编辑：进 = 整行卡头收起（负的 margin-bottom 让正文盖上来，卡头的字淡掉，··· 留在原处），
 * 编辑器里的标题从正文上沿滑出来（负的 margin-top → 0，淡入）；卡头高 + 正文上边距换成标题这一块 + 新的上边距（--fold-pt），卡片高度不变。
 * 出 = 反过来，显示的正文里标题滑回去，最后 done 再把它藏起来；正文上沿以外的部分剪掉。
 * 三样一起用同一条缓动走（WAAPI，不改 DOM 属性，ProseMirror 看不到），每一帧加起来一样高；减弱动效时直接到位
 */
function foldHeader(id: string, entering: boolean, setFolded: (v: boolean) => void, done: () => void) {
  const face = document.querySelector<HTMLElement>(`.card[data-id="${CSS.escape(id)}"] > .cface`);
  const head = face?.querySelector<HTMLElement>(":scope > .chead"), body = face?.querySelector<HTMLElement>(":scope > .nbody");
  if (!face || !head || !body) { setFolded(entering); return done(); }
  // 编辑器还在加载（先显示 .md-loading，标题照样藏着）：等编辑器出来（画出来之前）再开始，标题的动画只走在编辑器的标题上
  if (entering && !body.querySelector(`.md-pm > ${HEADS}`)) {
    const mo = new MutationObserver(() => { if (body.querySelector(`.md-pm > ${HEADS}`)) { mo.disconnect(); foldHeader(id, true, setFolded, done); } });
    mo.observe(body, { childList: true, subtree: true });
    setTimeout(() => mo.disconnect(), 3000);
    return;
  }
  const h = body.querySelector<HTMLElement>(entering ? `.md-pm > ${HEADS}` : `:scope > ${HEADS}`);
  let H: number, p0: number, p1: number;
  if (entering) {
    H = head.offsetHeight; p0 = parseFloat(getComputedStyle(body).paddingTop);
    face.style.setProperty("--fold-h", `${H}px`); face.style.setProperty("--fold-p0", `${p0}px`);
    setFolded(true);
  } else {
    H = parseFloat(face.style.getPropertyValue("--fold-h")) || head.offsetHeight;
    p0 = parseFloat(face.style.getPropertyValue("--fold-p0")) || 0;
  }
  const blk = h ? block(h) : 0;
  if (entering) { p1 = Math.max(6, H + p0 - blk); face.style.setProperty("--fold-pt", `${p1}px`); face.dataset.foldBlk = String(blk); }
  // 出：显示的标题和编辑器里的不一定一样高（差零点几到几像素）：起点的上边距补上这点差，第一帧和编辑时摆得一样，最后落回原来的上边距
  else p1 = Math.max(0, parseFloat(getComputedStyle(body).paddingTop) + (parseFloat(face.dataset.foldBlk ?? "") || blk) - blk);
  if (reduceMotion()) { if (!entering) setFolded(false); return done(); }
  const opts: KeyframeAnimationOptions = { duration: 220, easing: "cubic-bezier(.2, .8, .2, 1)", fill: entering ? "none" : "forwards" };
  const dir = <T,>(a: T, b: T) => (entering ? [a, b] : [b, a]);
  const hs = getComputedStyle(head);
  const pad = body.animate(dir({ paddingTop: `${p0!}px` }, { paddingTop: `${p1!}px` }) as Keyframe[], opts);
  const anims = [pad,
    head.animate(dir({ marginBottom: "0px", backgroundColor: hs.backgroundColor, borderBottomColor: hs.borderBottomColor }, { marginBottom: `${-H}px`, backgroundColor: "transparent", borderBottomColor: "transparent" }) as Keyframe[], opts),
    ...[...head.children].filter((e) => !e.classList.contains("ib")).map((e) => e.animate(dir({ opacity: 1, transform: "none" }, { opacity: 0, transform: "translateY(-30%)" }) as Keyframe[], opts)),
    // 滑动时标题在正文上沿外面的那部分剪掉（只剪上边，下面和两侧照常溢出）
    body.animate([{ clipPath: "inset(0 -100vmax -100vmax -100vmax)" }, { clipPath: "inset(0 -100vmax -100vmax -100vmax)" }], opts),
  ];
  const slide = (e: HTMLElement, blk: number) => e.animate(dir({ marginTop: `${-blk}px`, opacity: 0 }, { marginTop: "0px", opacity: 1 }) as Keyframe[], opts);
  if (h) anims.push(slide(h, blk));
  if (entering) return done();
  anims[0].onfinish = anims[0].oncancel = () => { setFolded(false); done(); for (const a of anims) a.cancel(); };
}

/** 选中时上方的小工具条：Box 的底色、Mark 的颜色；Text 没有 */
export function WritingToolbar(p: { card: NoteCard }) {
  return (
    <Show when={isSel(p.card.id) && sel.cards.length === 1 && editing()?.id !== p.card.id}>
      <Switch>
        <Match when={p.card.look === "box"}>
          <div class="ttb pill bdots" data-nodrag>
            <For each={BOX_FILLS}>{(k) => <button class={`bdot bf-${k}`} classList={{ on: (p.card.fill ?? "yellow") === k }} aria-label={k} data-tip={k[0].toUpperCase() + k.slice(1)} onClick={() => A.setBoxFill(p.card.id, k)} />}</For>
          </div>
        </Match>
        <Match when={p.card.look === "mark"}>
          <div class="ttb pill hdots" data-nodrag>
            <For each={HAND_COLORS}>{(k) => <button class={`hdot hc-${k}`} classList={{ on: p.card.hand === k }} aria-label={k} data-tip={k[0].toUpperCase() + k.slice(1)} onClick={() => A.setMarkColor(p.card.id, k)} />}</For>
          </div>
        </Match>
      </Switch>
    </Show>
  );
}
