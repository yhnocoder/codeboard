// 宿主发来的消息。
import { batch } from "solid-js";
import { reconcile } from "solid-js/store";
import { migrateBoard, findCard, isCode, type HostToBoard } from "@codeboard/core";
import { state, setState, markSaved, resetHistory, select, toast, mutate, setLineSel, sel } from "./state/store";
import { setCam } from "./state/camera";
import { setBanner, setFocusMode } from "./state/ui";
import * as A from "./actions";
import { send } from "./host";

export function onHost(m: HostToBoard) {
  switch (m.type) {
    case "init": {
      const b = migrateBoard(m.board);
      batch(() => {
        setState("host", m.host);
        setState("boards", m.boards);
        setState("views", m.views);
        setState("stale", m.stale);
        setState("board", reconcile(b));
        setState("loaded", true);
        setFocusMode(!!m.host.focus);
        setBanner(true);
      });
      setCam(b.cam.x, b.cam.y, b.cam.z);
      markSaved();
      resetHistory();
      select({});
      break;
    }
    case "views": setState("views", (v) => ({ ...v, ...m.views })); break;
    case "stale": {
      // moved：只是挪了位置，白板静默跟上（行号、Link、Sidenote 一起平移）
      const moved = Object.entries(m.stale).filter(([, s]) => s.state === "moved");
      if (moved.length) {
        mutate((b) => {
          for (const [sid, s] of moved) {
            if (s.state !== "moved") continue;
            for (const c of b.cards) for (const k of c.kind === "compare" ? c.cols : [c]) {
              if (!isCode(k)) continue;
              const seg = k.segments.find((q) => q.id === sid);
              if (!seg) continue;
              const d = s.start - seg.start;
              seg.start = s.start; seg.end = s.end;
              seg.hidden = seg.hidden?.map(([a, e]) => [a + d, e + d]);
              seg.hl = seg.hl?.map((l) => l + d);
              for (const l of b.links) if (l.from.seg === sid && l.from.line) l.from.line += d;
              for (const n of b.sidenotes) if (n.at.seg === sid && n.at.lines) n.at.lines = [n.at.lines[0] + d, n.at.lines[1] + d];
            }
          }
        });
      }
      setState("stale", (o) => {
        const n = { ...o };
        for (const [k, v] of Object.entries(m.stale)) n[k] = v.state === "moved" ? { state: "ok" } : v;
        return n;
      });
      break;
    }
    case "boards": setState("boards", m.boards); break;
    case "host": setState("host", (h) => ({ ...h, ...m.host })); if (m.host.focus !== undefined) setFocusMode(!!m.host.focus); break;
    case "add": {
      const ids = A.addCards(m.cards);
      if (m.ask === "split" && ids.length === 1) askSplit(ids[0]);
      break;
    }
    case "appendSegment": {
      setState("views", m.seg.id, m.view);
      mutate((b) => {
        const c = findCard(b, m.card)?.card;
        if (!isCode(c)) return;
        c.segments.push(m.seg);
      });
      A.revealCard(m.card);
      toast("Added a segment to the card");
      break;
    }
    case "addSidenote": {
      const ls = A.currentLineSel();
      const at = ls ? { card: ls.card, seg: ls.seg, lines: [ls.start, ls.end] as [number, number] } : sel.cards.length === 1 ? { card: sel.cards[0] } : null;
      if (!at) { toast("Select lines on the board first, then press ⌥S in the editor"); break; }
      A.addSidenote({ at, kind: "code", code: m.seg } as any, m.view);
      toast("Added as Sidenote");
      break;
    }
    case "reveal": {
      const f = findCard(state.board, m.card);
      if (!f) break;
      select({ cards: [f.host.id] });
      if (m.lines && m.seg) setLineSel({ card: m.card, seg: m.seg, start: m.lines[0], end: m.lines[1] });
      A.revealCard(m.card);
      break;
    }
    case "command": A.runCommand(m.name, m.arg); break;
    case "toast": toast(m.text, m.action ? [{ label: m.action.label, run: () => A.runCommand(m.action!.command, m.action!.arg) }] : undefined); break;
  }
}

/** 选中的代码里有 ≥2 个顶层函数：问一次 */
async function askSplit(id: string) {
  const { choose } = await import("./ui/Menu");
  const i = await choose("The selection spans several functions", ["Split into Cards", "Merge into One Card", "Keep as Snippet"], { text: "Split makes one card per function. Merge makes one card with a segment per function.", def: 0 });
  if (i === 0 || i === 1) A.splitSnippet(id, i === 1);
}
void send;
