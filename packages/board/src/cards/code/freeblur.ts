// Free code being edited loses focus: a click on its own card (the language picker, a header button) or on a menu it opened
// keeps it editing (focus comes back once the menu closed); a click inside its completion list or tooltip too; anywhere else
// ends the edit and saves the code
import type { CodeCard } from "@codeboard/core";
import { editing, setEditing } from "../../state/ui";
import { lastDown } from "../../state/measure";
import { afterMenu } from "../../ui/Menu";
import * as act from "../../actions";
import type { FreeEditCtl } from "../FreeEdit";

export function freeEditBlur(card: () => CodeCard, e: FocusEvent, ed: FreeEditCtl) {
  const el = ed.el;
  const save = () => {
    act.setFreeCode(card().id, ed.text().replace(/\s+$/, ""));
    setEditing(null);
  };
  const t = (e.relatedTarget as HTMLElement | null) ?? lastDown()?.target;
  if (t && !el.contains(t) && (el.closest(".card")?.contains(t) || t.closest?.(".ctx"))) {
    const still = () => el.isConnected && editing()?.id === card().id;
    setTimeout(() => {
      if (!still()) return;
      afterMenu(() => {
        if (!still()) return;
        const d = lastDown()?.target,
          mine = !!d && (el.closest(".card")?.contains(d) || !!d.closest?.(".ctx"));
        if (mine) ed.focus();
        else save();
      });
    }, 0);
    return;
  }
  if (t?.closest?.(".cbcm-tip, .cm-tooltip")) {
    setTimeout(() => ed.focus(), 0);
    return;
  }
  save();
}
