import { createMemo, Show, For } from "solid-js";
import {
  cardTitle,
  hiddenLang,
  codeGlyph,
  versionLabel,
  fileCount,
  mixedVersions,
  descendants,
  isMine,
  onVariant,
  upstreamSegs,
  UPSTREAM,
  type CodeCard,
  type Graph,
} from "@codeboard/core";
import { langLabel } from "@codeboard/analysis/langs";
import { state, flows, collapsedSet, placeOf, shared, sharedOn } from "../state/store";
import { Glyph } from "../stickers/glyphs";
import { editing, setEditing } from "../state/ui";
import { Icon } from "../ui/icons";
import { Editable } from "../ui/Editable";
import { openMenuAt, below, ownMenu } from "../ui/Menu";
import * as act from "../actions";
import { cardStale, uncommitted } from "@codeboard/core/commands";
import { staleOf } from "../state/views";
import { merged } from "../state/variants";
import { justDragged } from "../interact";
import { kbd } from "../keymap";

export function CodeHead(p: { card: CodeCard; col?: boolean }) {
  const c = () => p.card;
  const more = ownMenu();
  const node = createMemo(() => flows().byId.get(c().id));
  // 折叠后因为它藏起来的卡（别的路径还能走到的不算）
  const hiddenKids = createMemo(() =>
    placeOf(c().id).collapsed && node() ? descendants(flows(), c().id).filter((k) => collapsedSet().has(k)).length : 0,
  );
  // 连进来的箭头：这块白板上的 + 别的白板上连到这张共享卡的（宿主算好的 shared）
  const linkedIn = createMemo(() => act.linksInto(c().id).length + (shared[c().id]?.ins.length ?? 0));
  const onBoards = () => sharedOn(c().id);
  const review = createMemo(() => act.sidenotesOf(c().id).some((n) => n.review));
  const s0 = () => c().segments[0];
  const stale = createMemo(() => cardStale(c(), staleOf));
  const mixed = () => mixedVersions(c());
  const multi = () => c().segments.length > 1;
  const free = () => s0()?.src.kind === "free";
  const notes = () => act.sidenotesOf(c().id).filter((n) => !n.at.lines);
  // 有 Variant 时版本按钮说的是上游（显示的可能是我的分支）
  const onVar = () => onVariant(c());
  const up0 = () => (onVar() ? upstreamSegs(c())[0] : s0());
  const mine = createMemo(() => isMine(c()));
  const revLabel = () => (mixed() ? "Mixed" : versionLabel(up0()?.version, true));
  return (
    <div class="chead" data-drag>
      <Show when={node() && !state.host.settings.hideNumbers}>
        <span class="step" data-tip="Click: change mark · Drag: move with the cards it calls">
          <MarkView g={node()!} />
        </span>
      </Show>
      <Show when={!p.col && placeOf(c().id).start}>
        <span class="startt" data-tip="Start card: Walkthrough and the call tree start here">
          START
        </span>
      </Show>
      <Show when={hiddenKids()}>
        <button class="subc" data-tip="Expand Subtree" data-nodrag onClick={() => act.toggleCollapse(c().id)}>
          ▸ {hiddenKids()}
        </button>
      </Show>
      <Show when={!p.col && placeOf(c().id).locked}>
        <button
          class="lockb"
          data-tip="Unlock"
          data-kbd={kbd("lock")}
          data-nodrag
          onClick={() => act.toggleLock([c().id])}
        >
          <Icon name="lock" />
        </button>
      </Show>
      <Show when={!free()}>
        <span class="kind" classList={{ c: codeGlyph(c()) !== "ƒ" }}>
          {codeGlyph(c())}
        </span>
      </Show>
      <Show when={c().gen}>
        <span class="gentag" data-tip="Generated code: pinned to a run, not a commit">
          Generated · {c().gen!.what}
        </span>
      </Show>
      <Show when={!free() || c().title || (editing()?.kind === "title" && editing()?.id === c().id)}>
        <Editable
          class="ctitle"
          kind="title"
          id={c().id}
          value={free() ? (c().title ?? "") : cardTitle(c())}
          onCommit={(v) => act.renameCard(c().id, v)}
        />
      </Show>
      <Show when={c().title && c().segments.length > 1}>
        <span class="plusn">+{c().mergedFrom ? c().mergedFrom!.length - 1 : 0 || ""}</span>
      </Show>
      <Show when={!free()}>
        <span
          class="cpath"
          data-tip={multi() ? "Open First Segment in Editor" : "Open in Editor"}
          data-kbd="↵"
          onClick={() => !justDragged() && act.openCode(c().id)}
        >
          <span class="rw">
            <span class="rl">
              {multi()
                ? `${c().segments.length} segments${fileCount(c()) > 1 ? ` · ${fileCount(c())} files` : ""}`
                : `${shortPath(s0()?.path ?? "")}:${s0()?.start}${s0() && hiddenLang(s0()!) ? ` · ${hiddenLang(s0()!)}` : ""}`}
            </span>
          </span>
        </span>
      </Show>
      <Show when={act.dispatchOf(c().id)}>
        {(n) => (
          <span class="disp1" data-tip="Picked from a dynamic dispatch: the others are the grey boxes beside it">
            1 of {n()}
          </span>
        )}
      </Show>
      <span class="grow" />
      <Procs card={c().id} procs={c().procs} />
      {/* 悬停才出现的按钮放在右侧这一组的最左边：没悬停时它们不占宽度（.hov 收成 0 宽），标题能用满整行，悬停时展开、淡入 */}
      {/* 窄卡卡头的取舍（styles.css「卡头优先级」）：版本 / + uncommitted 先缩成小记号，再收起 ← N，然后路径省略，标题最后；
          .rw 里的 .rl 放不下时整个折到看不见的第二行。完整文字在 data-tip 里 */}
      <span class="hov">
        <span>
          <button
            class="ib cpy"
            aria-label="Copy Code"
            data-tip="Copy Code"
            data-nodrag
            onClick={() => act.copyCard(c())}
          >
            <Icon name="copy" />
          </button>
          <Show when={free()}>
            <button
              class="lang"
              data-tip="Change Language"
              data-nodrag
              onClick={(e) => act.langMenu(c().id, e.currentTarget)}
            >
              {langLabel(s0()?.lang ?? "python")}
            </button>
          </Show>
        </span>
      </span>
      <Show when={review()}>
        <span class="rvdot" data-tip="A sidenote's line changed in the new version: check it" />
      </Show>
      <Show when={act.openQuestionsOn(c().id)}>
        {(n) => (
          <button
            class="qcount"
            data-tip="Open questions on this card"
            data-nodrag
            onClick={() => act.openQuestionsOf(c().id)}
          >
            ? {n()}
          </button>
        )}
      </Show>
      <Show when={onBoards() > 1}>
        <button
          class="shb"
          data-tip="Linked card on several boards: show where"
          data-nodrag
          onClick={(e) => act.showBoardsOf(c().id, e.currentTarget)}
        >
          <Icon name="boards" size={12} />
          {onBoards()} boards
        </button>
      </Show>
      <Show when={linkedIn()}>
        <button
          class="linkedin fold"
          data-tip={`← ${linkedIn()} · Linked here: show where the arrows come from`}
          data-nodrag
          onClick={(e) => act.showLinkedHere(c().id, e.currentTarget)}
        >
          <span class="rw">
            <span class="rl">← {linkedIn()}</span>
          </span>
        </button>
      </Show>
      <Show when={notes().length}>
        <button
          class="mk inline"
          data-notes={notes()
            .map((n) => n.id)
            .join(",")}
          data-nodrag
          onPointerEnter={(e) =>
            act.hoverMarker(
              e.currentTarget,
              notes().map((n) => n.id),
            )
          }
          onClick={(e) =>
            act.pinMarker(
              e.currentTarget,
              notes().map((n) => n.id),
            )
          }
        >
          {notes().length}
        </button>
      </Show>
      <Show when={c().gen}>
        <span
          class="genrun"
          data-tip="The run or params this was generated from · click to edit"
          data-nodrag
          onClick={() => setEditing({ kind: "gen", id: c().id })}
        >
          <Editable
            class="grun"
            kind="gen"
            id={c().id}
            value={c().gen!.run ?? ""}
            placeholder="Run / params"
            onCommit={(v) => act.setGenRun(c().id, v)}
          />
        </span>
      </Show>
      <Show when={merged()[c().id]}>
        <button
          class="vmdot"
          data-tip="Merged upstream · turn back into a normal card?"
          data-nodrag
          onClick={() => act.mergedPrompt(c().id)}
        />
      </Show>
      <Show when={mine()}>
        <span class="mine" data-tip="This card shows your changes, not upstream">
          MINE
        </span>
      </Show>
      <Show when={!free()}>
        <button
          class="rev fold"
          data-dragclick
          classList={{
            new: stale() === "changed" || stale() === "hidden",
            hollow: stale() === "hidden",
            lost: stale() === "lost",
          }}
          data-tip={`${revLabel()} · ${stale() === "changed" ? "New version · View Diff" : stale() === "hidden" ? "Changes only in hidden lines" : s0()?.version.kind === "hash" ? "Unknown version (not in git)" : "Pinned version"}`}
          onClick={(e) =>
            justDragged()
              ? undefined
              : stale() === "changed" || stale() === "hidden"
                ? act.openDiff(c().id)
                : onVar()
                  ? act.switchVariant(c().id, UPSTREAM)
                  : act.commitMenu(c().id, e.currentTarget)
          }
        >
          <span class="rw">
            <span class="rl">
              <Show when={stale() === "changed" || stale() === "hidden"}>
                <i />
              </Show>
              {revLabel()}
            </span>
          </span>
        </button>
      </Show>
      <Show
        when={
          !c().variants?.length &&
          (uncommitted(c()) || c().segments.some((s) => state.stale[s.id]?.state === "uncommitted"))
        }
      >
        <button
          class="rev unc fold"
          data-tip="+ uncommitted · HEAD vs Working Tree"
          data-nodrag
          onClick={() => act.openWorktreeDiff(c().id)}
        >
          <span class="rw">
            <span class="rl">+ uncommitted</span>
          </span>
        </button>
      </Show>
      <Show when={!p.col}>
        <button
          class="ib cmenu"
          classList={{ on: more.open() }}
          aria-label="Card Menu"
          data-tip="More Actions"
          data-nodrag
          data-export="strip"
          onClick={(e) => {
            act.cardMenu(c().id, ...below(e.currentTarget));
            more.opened();
          }}
        >
          <Icon name="more" />
        </button>
      </Show>
    </div>
  );
}

/** 进程标签：rank 0、Scheduler × TP；浅的是线程 / CUDA stream。点一下改或删 */
export function Procs(p: { card: string; procs?: { text: string; light?: boolean }[] }) {
  return (
    <For each={p.procs ?? []}>
      {(t, i) => (
        <button
          class={act.procCls(t)}
          data-tip={t.light ? "Thread / stream · click to edit" : "Process · click to edit"}
          data-nodrag
          onClick={(e) =>
            openMenuAt(
              [
                { label: "Edit…", run: () => void act.editProc(p.card, i()) },
                { label: "Remove", danger: true, run: () => act.removeProc(p.card, i()) },
              ],
              e.currentTarget,
            )
          }
        >
          {t.text}
        </button>
      )}
    </For>
  );
}

/** 调用图标记：字母，或用户选的图标（内置贴纸） */
export function MarkView(p: { g: Graph }) {
  return (
    <Show when={"icon" in p.g.mark} fallback={<>{p.g.label}</>}>
      <Glyph icon={{ pack: "builtin", name: (p.g.mark as { icon: string }).icon }} size={13} />
    </Show>
  );
}
const shortPath = (p: string) => p.split("/").slice(-1)[0];
