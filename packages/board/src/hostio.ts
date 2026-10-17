// 宿主发来的消息。
import { batch } from "solid-js";
import { reconcile } from "solid-js/store";
import { loadBoard, findCard, isCode, allCodeCards, rebaseSegment, shiftBy, type HostToBoard } from "@codeboard/core";
import { state, setState, markSaved, resetHistory, select, toast, mutate, sync, setLineSel, sel } from "./state/store";
import { setCam } from "./state/camera";
import { setBanner } from "./state/ui";
import * as A from "./actions";
import { choose } from "./ui/Menu";

export function onHost(m: HostToBoard) {
  switch (m.type) {
    case "init": {
      const b = loadBoard(m.board);
      batch(() => {
        setState("host", m.host);
        setState("boards", m.boards);
        setState("views", m.views);
        setState("stale", m.stale);
        setState("board", reconcile(b));
        setState("loaded", true);

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
      // moved：只是挪了位置，白板静默跟上（行号、Link、Sidenote 一起平移）。
      // 这是跟宿主同步，不是用户的操作，所以走 sync：不进撤销栈，⌘Z 回到更早的快照后会再平移一次（按段现在的位置算到目标行，不会平移两遍）
      const moved = Object.entries(m.stale).filter(([, s]) => s.state === "moved");
      if (moved.length) {
        sync((b) => {
          for (const [sid, s] of moved) {
            if (s.state !== "moved") continue;
            for (const k of allCodeCards(b)) {
              const seg = k.segments.find((q) => q.id === sid);
              if (seg) rebaseSegment(b, k.id, { ...seg, start: s.start, end: s.end, version: s.version ?? seg.version }, shiftBy(s.start - seg.start));
            }
            for (const n of b.sidenotes) if (n.kind === "code" && n.code.id === sid) n.code = { ...n.code, start: s.start, end: s.end, version: s.version ?? n.code.version };
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
    case "host": setState("host", (h) => ({ ...h, ...m.host })); break;
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
    case "key": A.keyAction(m.action); break;
    case "rename": if (m.name.trim()) mutate((b) => { b.name = m.name.trim(); }); break;
    case "replaceSegment": A.replaceSegment(m.card, m.seg, m.view); break;
    case "toast": toast(m.text); break;
    case "githubPicker": A.openGitHubPicker(m.repo); break;
  }
}

/** 选中的代码里有 ≥2 个顶层函数：问一次 */
async function askSplit(id: string) {
  const i = await choose("The selection spans several functions", ["Split into Cards", "Merge into One Card", "Keep as Snippet"], { text: "Split makes one card per function. Merge makes one card with a segment per function.", def: 0 });
  if (i === 0 || i === 1) A.splitSnippet(id, i === 1);
}
