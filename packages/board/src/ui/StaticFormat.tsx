// 静态 Note 正文里选了字时的小工具条（Bold、Highlight）：样子、出现的时机和编辑器里的选区工具条一样（.md-bubble，
// 选区停住 TOOLBAR_SETTLE 后才出，按着鼠标时不算停住），点了直接改原文，不进编辑
import { createEffect, createMemo, createSignal, on, onCleanup, Show } from "solid-js";
import { Portal } from "solid-js/web";
import { Icon, place, virtual, TOOLBAR_SETTLE, type IconName } from "@yhnocoder/markdown/ui";
import type { StaticMark } from "@yhnocoder/markdown";
import { formatStaticSel, staticSel, staticSelHas, type StaticSel } from "../actions/format";
import { sel } from "../state/selection";
import { editing } from "../state/ui";
import { cam } from "../state/camera";
import { kbd } from "../keymap";

const keyOf = (s: StaticSel | null) => (s ? `${s.id}:${s.range.from}:${s.range.to}` : "");

export function StaticFormat() {
  let el: HTMLDivElement | undefined,
    timer: ReturnType<typeof setTimeout> | undefined,
    down = false,
    last = "";
  const [cur, setCur] = createSignal<StaticSel | null>(null);
  const arm = () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      if (!down) setCur(staticSel());
    }, TOOLBAR_SETTLE);
  };
  const check = () => {
    const s = staticSel(),
      k = keyOf(s);
    if (!s) {
      clearTimeout(timer);
      last = "";
      setCur(null);
      return;
    }
    // 同一段字（改了格式后正文重画、选区放回原处）：工具条留着，跟着新的字走
    if (k === last) {
      if (cur()) setCur(s);
      return;
    }
    last = k;
    setCur(null);
    arm();
  };
  const press = (e: PointerEvent) => {
    if (e.button === 0 && !(e.target as Element).closest?.(".md-bubble")) down = true;
  };
  const release = () => {
    if (!down) return;
    down = false;
    if (staticSel()) {
      setCur(null);
      arm();
    }
  };
  document.addEventListener("selectionchange", check);
  window.addEventListener("pointerdown", press, true);
  window.addEventListener("pointerup", release, true);
  onCleanup(() => {
    clearTimeout(timer);
    document.removeEventListener("selectionchange", check);
    window.removeEventListener("pointerdown", press, true);
    window.removeEventListener("pointerup", release, true);
  });
  // 换了选中的卡、进了编辑：选区还在也不算了
  // Entering edit: just drop it. Reading the selection there (staticSel) would force a layout of the editor being mounted
  // in the same task (a long Note took 200 ms more to open)
  createEffect(
    on(
      () => [sel.cards.length, sel.cards[0], editing()],
      () => {
        if (editing()) {
          clearTimeout(timer);
          last = "";
          setCur(null);
          return;
        }
        check();
      },
      { defer: true },
    ),
  );
  const pos = () => {
    const s = cur();
    if (!s || !el) return;
    // 跨行的选区：贴着第一行选中的那段字，不按几行合起来的外框（那样会落到整段的正中）
    const r = [...s.dom.getClientRects()].find((q) => q.width > 0) ?? s.dom.getBoundingClientRect(),
      box = el;
    void place(box, virtual({ x: r.left, y: r.top, width: r.width, height: r.height }), "top", { gap: 8, pad: 6 }).then(
      ({ x, y }) => {
        if (cur() === s) {
          box.style.left = `${x}px`;
          box.style.top = `${y}px`;
        }
      },
    );
  };
  // 镜头动了，选中的字跟着卡走：工具条也跟着
  createEffect(on(() => [cur(), cam.x, cam.y, cam.z], pos));
  const has = createMemo(() => {
    const s = cur();
    return { bold: !!s && staticSelHas(s, "bold"), highlight: !!s && staticSelHas(s, "highlight") };
  });
  const B = (mark: StaticMark, icon: IconName, tip: string, key: string) => (
    <button
      class="tbtn md-ib"
      classList={{ on: has()[mark] }}
      aria-pressed={has()[mark]}
      aria-label={`${tip} (${kbd(key)})`}
      data-tip={tip}
      data-kbd={kbd(key)}
      onClick={() => {
        formatStaticSel(mark);
        check();
      }}
    >
      <Icon name={icon} />
    </button>
  );
  return (
    <Show when={cur()}>
      <Portal>
        <div
          ref={(e) => {
            el = e;
            queueMicrotask(pos);
          }}
          class="pill md-bubble md-static-bubble"
          onMouseDown={(e) => e.preventDefault()}
          onPointerDown={(e) => e.stopPropagation()}
        >
          {B("bold", "bold", "Bold", "staticBold")}
          {B("highlight", "highlight", "Highlight", "staticHighlight")}
        </div>
      </Portal>
    </Show>
  );
}
