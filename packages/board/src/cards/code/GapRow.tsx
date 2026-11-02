// A run of hidden lines in a code card: how many, Show (for lines hidden by hand), the arrows from them, changed upstream
import { Show } from "solid-js";
import type { CodeCard, Row } from "@codeboard/core";
import { state } from "../../state/store";
import { linksFrom, toggleShown } from "../../state/ui";

export function GapRow(p: { r: Extract<Row, { t: "gap" }>; i: number; card: CodeCard }) {
  const n = () => p.r.to - p.r.from + 1;
  const links = () =>
    linksFrom(p.card.id).filter((l) => l.from.seg === p.r.seg && l.from.line! >= p.r.from && l.from.line! <= p.r.to)
      .length;
  const changed = () => {
    const s = state.stale[p.r.seg];
    return s?.state === "changed" && s.hiddenOnly;
  };
  return (
    <div class="gap" classList={{ mgap: !p.r.manual }} data-r={p.i}>
      ⋯ {n()} line{n() > 1 ? "s" : ""} hidden ({p.r.from === p.r.to ? p.r.from : `${p.r.from}–${p.r.to}`})
      <Show when={p.r.manual}>
        {" "}
        ·{" "}
        <b data-nodrag onClick={() => toggleShown(`${p.r.seg}:${p.r.from}`)}>
          Show
        </b>
      </Show>
      <Show when={links()}>
        {" "}
        · {links()} link{links() > 1 ? "s" : ""}
      </Show>
      <Show when={changed()}>
        {" "}
        · <span class="chgd">Changed</span>
      </Show>
    </div>
  );
}
