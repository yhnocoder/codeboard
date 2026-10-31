import { batch } from "solid-js";
import { reconcile } from "solid-js/store";
import { loadBoard, findCard, isCode, allCodeCards, rebaseUpstream, upstreamSegs, shiftBy, walkOrder, removeCards, type HostToBoard, type Sidenote } from "@codeboard/core";
import { state, setState, setShared, flows } from "./state/store";
import { putViews, putStale, resetSegs } from "./state/views";
import { markSaved, setBoard, mutate, sync, syncShared, syncGone, syncMerged } from "./state/changes";
import { select, clearSel, setLineSel, lineSel, sel } from "./state/selection";
import { toast } from "./state/toast";
import { setCam } from "./state/camera";
import { cardsMeasured } from "./state/measure";
import { putSkels, setCrumbs, setWalkBack } from "./state/subboards";
import { boardSwitched } from "./state/root";
import * as A from "./actions";
import { runKey } from "./keymap";
import { send } from "./host";
import { choose, pickOne, promptText } from "./ui/Menu";
import { setNoteAssets } from "./md/images";
import { applyMathPreamble } from "./md/math";
import { preloadEditor } from "./md/load";
import { putBoardRefs } from "./md/refs";
import { preloadCm } from "./cm/load";
import { questionsOpen, setWelcome } from "./state/questions";

let preloaded = false;
/** 进出子白板、旧白板还在淡出时收到的 init 和它后面的消息：淡出完再按顺序处理（actions/subboards.ts switchGate） */
let held: HostToBoard[] | null = null;
export function onHost(m: HostToBoard) {
  if (held) { held.push(m); return; }
  const gate = m.type === "init" ? A.switchGate() : null;
  if (gate) {
    held = [m];
    void gate.then(() => { const q = held!; held = null; for (const x of q) onHost(x); });
    return;
  }
  handle(m);
}

function handle(m: HostToBoard) {
  switch (m.type) {
    case "init": {
      const b = loadBoard(m.board);
      batch(() => {
        // the host state and the segments' views and version states are replaced (store setState merges: the last board's would stay)
        setState("host", reconcile(m.host));
        setNoteAssets(m.host.assetBase);
        applyMathPreamble(m.host.settings.mathPreamble);
        if (!preloaded) { preloaded = true; preloadEditor(); preloadCm(); }
        setState("boards", m.boards);
        resetSegs(m.views, m.stale);
        setBoard(b, (m.crumbs ?? []).map((c) => c.id));
        A.resetShownViews();
        setState("loaded", true);
        // 换了一块白板（进入 / 离开子白板）：讲解、模式、拖动、弹出的面板、骨架、共享卡的情况都是上一块白板的（onBoardSwitch / boardSignal）
        boardSwitched();
        setCrumbs(m.crumbs ?? []);
        setWelcome(m.welcome ?? null);
        clearSel();
      });
      if (questionsOpen()) A.refreshQuestions();
      setCam(b.cam.x, b.cam.y, b.cam.z);
      markSaved();
      A.boardShown();
      if (m.walk) void hopWalk(m.walk);
      break;
    }
    case "skeletons": putSkels(m.boards); A.refreshRefs(); break;
    case "boardRefs": putBoardRefs(m.refs); break;
    case "crumbs": setCrumbs(m.crumbs); break;
    case "views": putViews(m.views); break;
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
      putStale(Object.fromEntries(Object.entries(m.stale).map(([k, v]) => [k, v.state === "moved" ? { state: "ok" } : v])));
      break;
    }
    case "boards": setState("boards", m.boards); break;
    case "host": setState("host", (h) => ({ ...h, ...m.host })); if (m.host.assetBase !== undefined) setNoteAssets(m.host.assetBase); break;
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
      putViews({ [m.seg.id]: m.view });
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
      const sticker = m.sticker;
      void A.revealCard(m.card).then(() => { if (sticker) A.openQuestion(sticker); });
      break;
    }
    case "key": runKey(A, m.action); break;
    case "rename": if (m.name.trim()) mutate((b) => { b.name = m.name.trim(); }); break;
    case "replaceSegment": A.replaceSegment(m.card, m.seg, m.view); break;
    case "toast": toast(m.text); break;
    case "run": A.applyRunMsg(m.apply); break;
    case "variants": A.applyVariantSync(m.cards); break;
    case "githubPicker": A.openGitHubPicker(m.repo); break;
    case "ask": {
      const a = m.ask;
      void (a.kind === "text" ? promptText(a.title, a.value, a.placeholder, a.ok, { text: a.text, password: a.password }) : pickOne(a.title, a.items))
        .then((value) => send({ type: "answer", id: m.id, value }));
      break;
    }
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

/** 跨白板的讲解：进了子白板就从它的调用图（没有就第一张卡）讲起（讲完回去），回到父白板就接着讲 */
async function hopWalk(w: NonNullable<Extract<HostToBoard, { type: "init" }>["walk"]>) {
  // 镜头按卡的实际大小框：没量过的卡只有存下来的估计值
  const board = state.board.id;
  await cardsMeasured();
  if (state.board.id !== board) return;
  if (w.into) {
    const start = flows().graphs[0]?.roots[0] ?? state.board.cards.find((c) => state.board.place[c.id])?.id;
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
}
const walkOrderLen = (root: string) => walkOrder(state.board, root).length;

/** 选中的代码里有 ≥2 个顶层函数：问一次 */
async function askSplit(id: string) {
  const i = await choose("The selection spans several functions", ["Split into Cards", "Merge into One Card", "Keep as Snippet"], { text: "Split makes one card per function. Merge makes one card with a segment per function.", def: 0 });
  if (i === 0 || i === 1) A.splitSnippet(id, i === 1);
}
