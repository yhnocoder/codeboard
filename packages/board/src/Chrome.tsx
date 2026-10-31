import { Show, For } from "solid-js";
import { state } from "./state/store";
import { mutate, canUndo, canRedo, undo, redo } from "./state/changes";
import { sel } from "./state/selection";
import { toast } from "./state/toast";
import { cam, camTarget, zoomAt, viewTracked } from "./state/camera";
import { walk, setKeysOpen, setPaletteOpen } from "./state/ui";
import { kbd } from "./keymap";
import { openMenu, promptText } from "./ui/Menu";
import { Icon } from "./ui/icons";
import { StaticFormat } from "./ui/StaticFormat";
import { startDraw } from "./state/mode";
import { THEMES, EXPERIMENTAL_THEMES } from "@codeboard/core";
import * as A from "./actions";
import { look, traffic, setTraffic } from "./state/look";
import { questionsOpen } from "./state/questions";
import { legendOpen, setLegendOpen, setTreeOpen, treeOpen } from "./state/calls";

/** 白板放在编辑器旁边（窄）：工具栏和缩放并成一行，少用的按钮收进 ⋯ */
const NARROW = 700;
const narrow = () => viewTracked().w < NARROW;

/** 盖在白板上的操作栏：底下的工具栏、右下角的 Dock（侧栏开关和缩放）。讲解时工具栏让开 */
export function Chrome() {
  return (
    <>
      <Show when={!walk()}>
        <Toolbar />
      </Show>
      <Show when={!narrow() || walk()}>
        <Dock />
      </Show>
      <StaticFormat />
    </>
  );
}

/** 唯一的工具栏；窄时右端接上缩放 */
function Toolbar() {
  const at = (el: HTMLElement) => {
    const r = el.getBoundingClientRect();
    return [r.left, r.top - 6] as const;
  };
  const codeMenu = (el: HTMLElement) => {
    const [x, y] = at(el);
    openMenu(
      [
        { label: "New Code", run: () => A.newFreeCode() },
        { label: "From GitHub…", run: () => A.openGitHubPicker() },
        { label: "Add Function…", kbd: kbd("search"), run: () => setPaletteOpen({ mode: "code" }) },
      ],
      x,
      y,
      { up: true },
    );
  };
  // 写在白板上、没有卡框的三种：和 Code 一样只开菜单
  const writeMenu = (el: HTMLElement) => {
    const [x, y] = at(el);
    openMenu(
      [
        { label: "New Text", kbd: kbd("newText"), run: () => A.newText() },
        { label: "New Box", kbd: kbd("newBox"), run: () => A.newBox() },
        { label: "New Mark", kbd: kbd("newMark"), run: () => A.newMark() },
      ],
      x,
      y,
      { up: true },
    );
  };
  // 图：选一张图，或把剪贴板里的图直接读成 Note（不留图片卡），或照一句描述让 AI 画一张 SVG
  const imageMenu = (el: HTMLElement) => {
    const [x, y] = at(el);
    openMenu(
      [
        { label: "New Image", run: () => void A.newImage() },
        {
          label: "Paste Image Text",
          kbd: kbd("pasteImageText"),
          hint: "A Note with the text of the image on the clipboard",
          run: () => void A.pasteImageText(),
        },
        {
          label: "New SVG from Text…",
          hint: "Describe a picture: AI draws it as an SVG image",
          run: () => void A.newSvgFromText(),
        },
      ],
      x,
      y,
      { up: true },
    );
  };
  // fold：窄时收进 ⋯ 时的菜单名（foldRun：收进去以后点它做的事，不给 = 和按钮一样）
  const tools: {
    icon: string;
    label: string;
    run: (el: HTMLElement) => void;
    tip?: string;
    kbd?: string;
    more?: boolean;
    fold?: string;
    foldRun?: () => void;
  }[] = [
    { icon: "note", label: "Note", kbd: kbd("newNote"), run: () => A.newNote() },
    { icon: "text", label: "Text", tip: "New Text, New Box, New Mark", more: true, run: writeMenu },
    { icon: "code", label: "Code", tip: "New Code, From GitHub, Add Function", more: true, run: codeMenu },
    {
      icon: "image",
      label: "Image",
      tip: "New Image, Paste Image Text, New SVG from Text",
      more: true,
      fold: "New Image",
      foldRun: () => void A.newImage(),
      run: imageMenu,
    },
    { icon: "web", label: "Web", fold: "New Web Card", tip: "New Web Card", run: () => A.newWeb() },
    { icon: "section", label: "Section", fold: "Draw a Section", tip: "Draw a Section", run: () => startDraw() },
    {
      icon: "arrowLink",
      label: "Arrow",
      fold: "New Arrow",
      tip: "Select two cards, or pick a card then click another",
      run: () => {
        if (sel.cards.length === 2) A.addLink({ card: sel.cards[0] }, { card: sel.cards[1] });
        else if (sel.cards.length === 1) A.startConnect(sel.cards[0]);
        else toast("Select a card first, then click another card");
      },
    },
    {
      icon: "sticker",
      label: "Sticker",
      fold: "Add a Sticker",
      tip: "Add a Sticker",
      run: (el) => A.stickerPicker(el),
    },
  ];
  const more = (e: MouseEvent) => {
    const el = e.currentTarget as HTMLElement,
      [x, y] = at(el);
    const folded: Parameters<typeof openMenu>[0] = narrow()
      ? [
          ...tools
            .filter((t) => t.fold)
            .map((t) => ({ label: t.fold!, run: () => (t.foldRun ? t.foldRun() : t.run(el)) })),
          { label: "Paste Image Text", kbd: kbd("pasteImageText"), run: () => void A.pasteImageText() },
          { label: "New SVG from Text…", run: () => void A.newSvgFromText() },
          null,
          { label: "Call Tree", checked: treeOpen(), run: () => setTreeOpen(!treeOpen()) },
          { label: "Arrow Legend", checked: legendOpen(), run: () => setLegendOpen(!legendOpen()) },
          ...(look() === "city"
            ? [{ label: "Moving Cars", checked: traffic(), run: () => setTraffic(!traffic()) }]
            : []),
          null,
        ]
      : [];
    openMenu(
      [
        ...folded,
        { label: "Undo", kbd: kbd("undo"), disabled: !canUndo(), run: () => undo() },
        { label: "Redo", kbd: kbd("redo"), disabled: !canRedo(), run: () => redo() },
        null,
        {
          label: "Rename Board…",
          run: () =>
            promptText("Rename Board", state.board.name).then(
              (v) =>
                v &&
                mutate((b) => {
                  b.name = v;
                }),
            ),
        },
        { label: "Export…", hint: "HTML snapshot, Markdown or PNG", run: () => A.openExport() },
        {
          label: "Export Boards…",
          hint: "A .codeboard file to import into another project",
          run: () => A.exportBoards(),
        },
        { label: "Questions", checked: questionsOpen(), run: () => A.toggleQuestions() },
        null,
        // 运行时：跑一次入口，给 Call 箭头挂上 observed 证据和实参
        {
          label: "Capture Run…",
          hint: "Run a Python entry once and mark the calls it makes",
          run: () => A.captureRun(),
        },
        { label: "Apply Run…", run: () => A.pickRun() },
        null,
        { label: "Settings…", kbd: kbd("settings"), run: () => A.openSettings() },
        // 快速换主题：和设置页的主题选择是同一个设置（codeboard.theme），换了就存下
        {
          label: "Theme",
          sub: THEMES.map(([id, name]) => ({
            label: name,
            checked: state.host.settings.theme === id,
            hint: EXPERIMENTAL_THEMES.includes(id) ? "Experimental" : undefined,
            run: () => A.setSetting("theme", id),
          })),
        },
        { label: "Keyboard Shortcuts", kbd: kbd("help"), run: () => setKeysOpen(true) },
        { label: "Copy Diagnostics", run: () => A.copyDiagnostics() },
      ],
      x,
      y,
      { up: true },
    );
  };
  return (
    <div class="over bbar">
      <div class="pill">
        <For each={narrow() ? tools.filter((t) => !t.fold) : tools}>
          {(t) => (
            <button
              class="tbtn"
              aria-label={t.label}
              data-tip={t.tip ?? `New ${t.label}`}
              data-kbd={t.kbd}
              onClick={(e) => t.run(e.currentTarget)}
            >
              <Icon name={t.icon} />
              <Show when={t.more}>
                <Icon name="chev" size={10} />
              </Show>
            </button>
          )}
        </For>
        <span class="sep" />
        <button
          class="tbtn"
          aria-label="Search"
          data-tip="Search Functions, Files, Cards · ? Shortcuts"
          data-kbd={kbd("search")}
          onClick={() => setPaletteOpen({ mode: "all" })}
        >
          <Icon name="search" />
        </button>
        <button class="ib" aria-label="More" data-tip="More" onClick={more}>
          <Icon name="more" />
        </button>
        <Show when={narrow()}>
          <span class="sep" />
          <Zoom />
        </Show>
      </div>
    </div>
  );
}

function Zoom() {
  return (
    <>
      <button
        class="ib"
        aria-label="Zoom Out"
        data-tip="Zoom Out"
        data-kbd={kbd("zoomOut")}
        onClick={() => zoomAt(0.8)}
      >
        <Icon name="minus" />
      </button>
      <span class="zoom" onClick={() => zoomAt(1 / camTarget().z)} data-tip="Zoom to 100%" data-kbd={kbd("zoom100")}>
        {Math.round(cam.z * 100)}%
      </span>
      <button class="ib" aria-label="Zoom In" data-tip="Zoom In" data-kbd={kbd("zoomIn")} onClick={() => zoomAt(1.25)}>
        <Icon name="plus" />
      </button>
      <span class="sep" />
      <button
        class="ib"
        aria-label="Fit to Window"
        data-tip="Fit to Window"
        data-kbd={kbd("fitWindow")}
        onClick={() => A.fitAll()}
      >
        <Icon name="fit" />
      </button>
    </>
  );
}

function Dock() {
  return (
    <div class="over dock">
      <div class="pill">
        {/* City 的红绿灯：车流开关，默认红灯（车不动）；绿灯时车沿路开（canvas/Traffic.tsx） */}
        <Show when={look() === "city"}>
          <button
            class="ib traffic"
            aria-label="Moving Cars"
            aria-pressed={traffic()}
            data-tip={traffic() ? "Stop Cars" : "Start Cars"}
            onClick={() => setTraffic(!traffic())}
          />
          <span class="sep" />
        </Show>
        <button
          class="ib"
          aria-label="Call Tree"
          aria-pressed={treeOpen()}
          data-tip="Call Tree"
          onClick={() => setTreeOpen(!treeOpen())}
        >
          <Icon name="layout" />
        </button>
        <button
          class="ib"
          aria-label="Questions"
          aria-pressed={questionsOpen()}
          data-tip="Questions on All Boards"
          onClick={() => A.toggleQuestions()}
        >
          <Icon name="question" />
        </button>
        <button
          class="ib"
          aria-label="Arrow Legend"
          aria-pressed={legendOpen()}
          data-tip="Arrow Legend"
          onClick={() => setLegendOpen(!legendOpen())}
        >
          <Icon name="compact" />
        </button>
        <span class="sep" />
        <Zoom />
      </div>
    </div>
  );
}
