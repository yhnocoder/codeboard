import { For } from "solid-js";
import { Icon } from "./icons";

/**
 * A sub-board's breadcrumb: ← Engine › Scheduler. The board shows it (BoardView), and before entering a sub-board
 * actions/subboards.ts lays out a hidden one (crumbSpot) to find where its current crumb will be: one markup for both, so that
 * spot is where the shown crumb lands
 */
export function CrumbsNav(p: {
  parents: readonly { name: string }[];
  cur: string;
  morph?: boolean;
  style?: string;
  leave?: (i?: number) => void;
}) {
  const last = (i: number) => i === p.parents.length - 1;
  return (
    <nav class="crumbs pill" classList={{ morph: !!p.morph }} style={p.style} aria-label="Parent boards">
      <button
        class="crumb back"
        aria-label="Back"
        data-tip="Back to the parent board"
        data-kbd="Esc"
        onClick={() => p.leave?.()}
      >
        <Icon name="left" size={14} />
      </button>
      <For each={p.parents}>
        {(c, i) => (
          <>
            <button
              class="crumb"
              data-tip={last(i()) ? "Back to the parent board" : undefined}
              data-kbd={last(i()) ? "Esc" : undefined}
              onClick={() => p.leave?.(i())}
            >
              {c.name}
            </button>
            <span class="csep">›</span>
          </>
        )}
      </For>
      <span class="crumb cur">{p.cur}</span>
    </nav>
  );
}
