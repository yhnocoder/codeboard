// 宿主发来的消息。换白板（init）时各处的界面状态由 onBoardSwitch 登记的重置一起清掉（state/root.ts）
import { batch } from "solid-js";
import { reconcile } from "solid-js/store";
import { loadBoard, findCard, isCode, allCodeCards, rebaseUpstream, upstreamSegs, shiftBy, walkOrder, removeCards, type HostToBoard, type Sidenote } from "@codeboard/core";
import { state, setState, markSaved, setBoard, select, toast, mutate, sync, syncShared, syncGone, syncMerged, setShared, setLineSel, lineSel, sel, flows } from "./state/store";
import { setCam } from "./state/camera";
import { resetSubboards, putSkels, setCrumbs, setWalkBack } from "./state/subboards";
import { boardSwitched } from "./state/root";
import * as A from "./actions";
import { runKey } from "./keymap";
import { choose } from "./ui/Menu";
import { setAssetBase } from "@yhnocoder/markdown";
import { preloadEditor } from "./md/load";
import { preloadCm } from "./cm/load";
import { questionsOpen, setWelcome } from "./state/questions";

let preloaded = false;
export function onHost(m: HostToBoard) {
  switch (m.type) {
    case "init": {
      const b = loadBoard(m.board);
      batch(() => {
        setState("host", m.host);
        setAssetBase(m.host.assetBase);
        if (!preloaded) { preloaded = true; preloadEditor(); preloadCm(); }
        setState("boards", m.boards);
        setState("views", m.views);
        setState("stale", m.stale);
        setBoard(b, (m.crumbs ?? []).map((c) => c.id));
        A.resetShownViews();
        setShared(reconcile({}));
        setState("loaded", true);
        // 换了一块白板（进入 / 离开子白板）：讲解、模式、弹出的面板、骨架、面包屑都是上一块白板的
        boardSwitched();
        resetSubboards(m.crumbs);
        setWelcome(m.welcome ?? null);
        select({});
      });
      if (questionsOpen()) A.refreshQuestions();
      setCam(b.cam.x, b.cam.y, b.cam.z);
      markSaved();
      if (m.walk) hopWalk(m.walk);
      break;
    }
    case "skeletons": putSkels(m.boards); break;
    case "crumbs": setCrumbs(m.crumbs); break;
    case "views": setState("views", (v) => ({ ...v, ...m.views })); break;
    case "stale": {
      // moved：只是挪了位置，白板静默跟上（行号、Link、Sidenote 一起平移，钉的版本换成找到它的那个版本）。
      // 这是跟宿主同步，不是用户的操作，所以走 sync：不进撤销栈，⌘Z 回到更早的快照后会再平移一次（按段现在的位置算到目标行，不会平移两遍）
      const moved = Object.entries(m.stale).filter(([, s]) => s.state === "moved");
      if (moved.length) {
        sync((b) => {
          for (const [sid, s] of moved) {
            if (s.state !== "moved") continue;
            for (const k of allCodeCards(b)) {
              // 有 Variant 的卡：版本状态说的是上游的段（显示的可能是我的分支）
              const seg = upstreamSegs(k).find((q) => q.id === sid);
              if (seg) rebaseUpstream(b, k.id, { ...seg, start: s.start, end: s.end, version: s.version }, shiftBy(s.start - seg.start));
            }
            for (const n of b.sidenotes) if (n.kind === "code" && n.code.id === sid) n.code = { ...n.code, start: s.start, end: s.end, version: s.version };
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
    case "host": setState("host", (h) => ({ ...h, ...m.host })); if (m.host.assetBase !== undefined) setAssetBase(m.host.assetBase); break;
    case "add": {
      const ids = A.addCards(m.cards);
      if (m.ask === "split" && ids.length === 1) askSplit(ids[0]);
      break;
    }
    case "undoAdd": {
      // 只拿掉那次加的卡（还在的），是白板上可以撤销的一步；之后在白板上做的别的改动都留着
      const gone = new Set(m.cards.filter((id) => state.board.cards.some((c) => c.id === id)));
      if (!gone.size) { toast("Those cards are no longer on the board"); break; }
      mutate((b) => removeCards(b, gone));
      if (sel.cards.some((id) => gone.has(id))) select({ cards: sel.cards.filter((id) => !gone.has(id)) });
      toast(`Removed the ${gone.size > 1 ? `${gone.size} cards` : "card"} just added`);
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
      const ls = lineSel();
      const at = ls ? { card: ls.card, seg: ls.seg, lines: [ls.start, ls.end] as [number, number] } : sel.cards.length === 1 ? { card: sel.cards[0] } : null;
      if (!at) { toast("Select lines on the board first, then press ⌥S in the editor"); break; }
      const n: Omit<Extract<Sidenote, { kind: "code" }>, "id"> = { at, kind: "code", code: m.seg };
      A.addSidenote(n, m.view);
      toast("Added as Sidenote");
      break;
    }
    case "reveal": {
      const f = findCard(state.board, m.card);
      if (!f) break;
      select({ cards: [f.host.id] });
      if (m.lines && m.seg) setLineSel({ card: m.card, seg: m.seg, start: m.lines[0], end: m.lines[1] });
      A.revealCard(m.card);
      if (m.sticker) A.revealQuestion(m.sticker);
      break;
    }
    case "key": runKey(A, m.action); break;
    case "rename": if (m.name.trim()) mutate((b) => { b.name = m.name.trim(); }); break;
    case "replaceSegment": A.replaceSegment(m.card, m.seg, m.view); break;
    case "toast": toast(m.text); break;
    case "run": A.applyRunMsg(m.apply); break;
    case "variants": A.applyVariantSync(m.cards); break;
    case "githubPicker": A.openGitHubPicker(m.repo); break;
    case "shared": if (m.views) A.sharedShown(m.cards.map((sc) => sc.card)); syncShared(m.cards, m.views); break;
    case "sharedInfo": setShared(reconcile(m.cards)); break;
    case "merged": syncMerged(m.patch, m.views); break;
    case "sharedGone": {
      const n = m.cards.filter((id) => findCard(state.board, id)).length;
      syncGone(m.cards);
      if (n) toast(n > 1 ? `${n} cards were deleted everywhere from another board` : "A card was deleted everywhere from another board");
      break;
    }
  }
}

/** 跨白板的讲解：进了子白板就从 start 讲起（讲完回去），回到父白板就接着讲 */
function hopWalk(w: NonNullable<Extract<HostToBoard, { type: "init" }>["walk"]>) {
  // 等卡片量好尺寸再动镜头
  setTimeout(() => {
    if (w.into) {
      const start = w.start ?? flows().graphs[0]?.roots[0] ?? state.board.cards.find((c) => state.board.place[c.id])?.id;
      if (!start) { A.leaveBoard(undefined, { resume: { root: w.into.root, i: w.into.i + 1 } }); return; }
      setWalkBack(w.into);
      A.startWalk(start, { single: true });
    } else if (w.resume) {
      const r = w.resume;
      if (!state.board.cards.some((c) => c.id === r.root) || r.i < 0) return;
      // 讲到头了（子白板是最后一步）：停在框上
      const n = walkOrderLen(r.root);
      if (r.i >= n) return;
      A.startWalk(r.root, { at: r.i });
    }
  }, 120);
}
const walkOrderLen = (root: string) => walkOrder(state.board, root).length;

/** 选中的代码里有 ≥2 个顶层函数：问一次 */
async function askSplit(id: string) {
  const i = await choose("The selection spans several functions", ["Split into Cards", "Merge into One Card", "Keep as Snippet"], { text: "Split makes one card per function. Merge makes one card with a segment per function.", def: 0 });
  if (i === 0 || i === 1) A.splitSnippet(id, i === 1);
}
