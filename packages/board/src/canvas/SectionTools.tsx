// A Section's frequent buttons: Fit Content, Color (with its five swatches) and Lock. The title shows them on hover
// (Sections.tsx SectionActs) and the Section's context menu at its top (actions/menus.ts sectionMenu)
import { For, Show, createMemo, createSignal, onCleanup } from "solid-js";
import type { Section } from "@codeboard/core";
import { Icon } from "../ui/icons";
import { kbd } from "../keymap";
import { fitFrame } from "../state/sections";
import { boardSignal } from "../state/root";
import { fitSections, setSectionColor, toggleLock } from "../actions/edit";
import { sectionById, sectionLocked } from "../actions/common";

export const SECTION_COLORS = [
  ["none", "None"],
  ["sand", "Warm Sand"],
  ["blue", "Light Blue"],
  ["green", "Light Green"],
  ["pink", "Light Pink"],
] as const;

// the Section whose context menu shows these buttons: its title hides its own meanwhile, so the row is not there twice
const [inMenu, setInMenu] = boardSignal<string | undefined>(undefined);
export { inMenu as sectionToolsInMenu };

/**
 * The buttons and the swatch row, laid out by whoever holds them (the title's .sacts, the menu's .mrow). live: they can show,
 * so it is worth working out whether Fit Content can do anything (not on every drag of a member card while they are hidden)
 */
export function SectionTools(p: { s: Section; live: boolean; swatches: boolean; setSwatches: (v: boolean) => void }) {
  // why Fit Content can't run ("" = it can)
  const why = createMemo(() =>
    !p.live
      ? ""
      : p.s.collapsed
        ? "expand the Section first"
        : sectionLocked(p.s)
          ? "the Section is locked"
          : fitFrame(p.s)
            ? ""
            : "no cards inside",
  );
  return (
    <>
      <button
        class="ib sfit"
        aria-label="Fit Content"
        aria-disabled={!!why()}
        data-tip={why() ? `Fit Content · ${why()}` : "Fit Content"}
        data-kbd={kbd("fitContent")}
        data-nodrag
        onClick={() => !why() && fitSections([p.s.id])}
      >
        <Icon name="fit" />
      </button>
      <button
        class="ib scolor"
        classList={{ on: p.swatches }}
        aria-label="Color"
        aria-expanded={p.swatches}
        data-tip="Color"
        data-nodrag
        onClick={() => p.setSwatches(!p.swatches)}
      >
        <Icon name="paint" />
      </button>
      <span class="swrow" classList={{ open: p.swatches }}>
        <span>
          <For each={SECTION_COLORS}>
            {([v, label]) => (
              <button
                class={`sw c-${v}`}
                classList={{ cur: (p.s.color ?? "none") === v }}
                aria-label={label}
                aria-pressed={(p.s.color ?? "none") === v}
                tabIndex={p.swatches ? 0 : -1}
                data-tip={label}
                data-nodrag
                onClick={() => setSectionColor([p.s.id], v === "none" ? undefined : v)}
              />
            )}
          </For>
        </span>
      </span>
      <button
        class="ib slock"
        classList={{ on: !!p.s.locked }}
        aria-label={p.s.locked ? "Unlock" : "Lock"}
        aria-pressed={!!p.s.locked}
        data-tip={p.s.locked ? "Unlock" : "Lock"}
        data-kbd={kbd("lock")}
        data-nodrag
        onClick={() => toggleLock([], [p.s.id])}
      >
        <Icon name="lock" />
      </button>
    </>
  );
}

/** The row at the top of a Section's context menu (Menu.tsx renders it in its .mrow); its swatches start folded */
export function SectionMenuRow(p: { id: string }) {
  const [swatches, setSwatches] = createSignal(false);
  setInMenu(p.id);
  onCleanup(() => setInMenu((v) => (v === p.id ? undefined : v)));
  return (
    <Show when={sectionById(p.id)}>
      {(s) => <SectionTools s={s()} live swatches={swatches()} setSwatches={setSwatches} />}
    </Show>
  );
}
