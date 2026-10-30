// 快捷键清单和 ? 浮层都从 keymap.ts 的表生成。
import { For, Show, createEffect, createSignal, onMount } from "solid-js";
import { THEMES, EXPERIMENTAL_THEMES, NOTE_FONT_LEVELS, NOTE_FONT_RANGE, type AiInfo, type HideFlags, type NoteFontLevel, type Settings as S } from "@codeboard/core";
import { state } from "../state/store";
import { settingsOpen } from "../state/ui";
import { ask, send } from "../host";
import * as A from "../actions";
import { Icon } from "./icons";
import { promptText } from "./Menu";
import { helpRows, matches } from "../keymap";
import { useOverlay } from "./overlay";
import { TUNE, tune, type TuneKey } from "../state/tune";
import { mathPreambleErrors } from "@yhnocoder/markdown";
import { applyMathPreamble, mathRev } from "../md/math";

const cur = (): S => state.host.settings;

/** 主题同步 + 设置页本身；BoardView 里挂一次 */
export function SettingsLayer() {
  createEffect(() => A.applyLook(state.host.settings.theme));
  createEffect(() => A.applyVscodeBg(state.host.settings.vscodeBg));
  createEffect(() => A.applyNoteFonts(state.host.settings.noteFontSize));
  // 设置页里改了马上生效（宿主那边改了也走这里；hostio 在白板画出来前先给一次）
  createEffect(() => applyMathPreamble(state.host.settings.mathPreamble));
  return <Show when={settingsOpen()} keyed>{(o) => <SettingsPage section={o.section} />}</Show>;
}

function SettingsPage(p: { section?: string }) {
  let el!: HTMLDivElement;
  // 盖住白板：白板快捷键都不响应；Esc、⌘, 关
  useOverlay({ close: () => A.closeSettings(), grab: true, modal: true, stay: true, keys: (e) => matches(e, "settings") && (A.closeSettings(), true) });
  onMount(() => {
    const t = p.section && el.querySelector<HTMLElement>(`[data-sec="${p.section}"]`);
    if (t) t.scrollIntoView({ block: "start" });
    el.focus({ preventScroll: true });
  });
  return (
    <div class="settings" ref={el} tabIndex={-1} role="dialog" aria-label="CodeBoard Settings"
      data-nodrag onWheel={(e) => e.stopPropagation()}>
      <div class="st-top">
        <h2>CodeBoard Settings</h2>
        <span class="st-sync">Synced to VS Code settings <code>codeboard.*</code></span>
        <span class="grow" />
        <button class="ib" aria-label="Close Settings" data-tip="Close" data-kbd="Esc" onClick={() => A.closeSettings()}><Icon name="close" /></button>
      </div>
      <div class="st-page">
        <Sec id="theme" title="Theme" hint="Light / dark follows VS Code.">
          <div class="st-themes">
            <For each={THEMES}>{([id, name]) => (
              <button class="st-sw" classList={{ on: cur().theme === id }} aria-pressed={cur().theme === id} onClick={() => A.setSetting("theme", id)}>
                <Swatch id={id} />
                <span class="st-swn">{name}</span>
                <Show when={EXPERIMENTAL_THEMES.includes(id)}><span class="st-exp">Experimental</span></Show>
              </button>
            )}</For>
          </div>
          <label class="st-check" data-tip="Cards, text and accents keep the theme's colors"><input type="checkbox" checked={cur().vscodeBg} onChange={(e) => A.setSetting("vscodeBg", e.currentTarget.checked)} />Use VS Code's Background</label>
          <div class="st-sub">When a theme or font size makes cards taller</div>
          <div class="st-chips">
            <For each={[["push", "Push Cards Below Down"], ["overlap", "Allow Overlap"]] as const}>{([v, lb]) => (
              <button class="st-chip pick" classList={{ on: cur().themeReflow === v }} onClick={() => A.setSetting("themeReflow", v)}>{lb}</button>
            )}</For>
          </div>
        </Sec>
        <Sec id="numbers" title="Call graph marks" hint="The letter or icon on cards that shows which call graph they belong to.">
          <label class="st-check"><input type="checkbox" checked={cur().hideNumbers} onChange={(e) => A.setSetting("hideNumbers", e.currentTarget.checked)} />Hide Call Graph Marks</label>
        </Sec>
        <Sec id="notes" title="Notes" hint="A Note that starts with a heading uses it as its title. The heading stays in the Note and shows while you edit. Font sizes apply to Notes while you read and edit them; Text cards keep their own sizes.">
          <label class="st-check"><input type="checkbox" checked={cur().noteHeadingInBody} onChange={(e) => A.setSetting("noteHeadingInBody", e.currentTarget.checked)} />Also Show the Title Heading in the Note</label>
          <NoteFonts />
        </Sec>
        <Sec id="math" title="Math preamble" hint={"\\newcommand and \\def lines that every formula on this project's boards can use. Saved in this project (.vscode/settings.json), not in your user settings. Typing \\ in a formula suggests them too."}>
          <Preamble />
        </Sec>
        <Sec id="ai" title="AI" hint="DeepSeek or a VS Code language model such as GitHub Copilot. Auto uses DeepSeek when its API key is set, otherwise a VS Code model (VS Code asks once before CodeBoard may use it). The key stays in VS Code's secret storage and never reaches the board.">
          <AiSettings />
        </Sec>
        <Sec id="hide" title="New cards hide" hint="What new code cards start with hidden. Each card can still toggle them.">
          <div class="st-checks">
            <For each={[["comments", "Comments"], ["docstrings", "Docstrings"], ["blank", "Blank Lines"]] as [keyof HideFlags, string][]}>{([k, lb]) => (
              <label class="st-check"><input type="checkbox" checked={!!cur().hideOnNew[k]} onChange={(e) => A.setSetting("hideOnNew", { ...cur().hideOnNew, [k]: e.currentTarget.checked })} />{lb}</label>
            )}</For>
          </div>
        </Sec>
        <Sec id="scope" title="Study Scope" hint="Packages that count as project code, besides the workspace.">
          <div class="st-chips">
            <span class="st-chip fixed" data-tip="Always in scope">workspace</span>
            <For each={cur().studyScope}>{(pkg) => (
              <span class="st-chip">{pkg}<button class="st-x" aria-label={`Remove ${pkg}`} onClick={() => A.setSetting("studyScope", cur().studyScope.filter((x) => x !== pkg))}><Icon name="close" size={11} /></button></span>
            )}</For>
            <button class="st-chip add" onClick={async () => {
              const v = await promptText("Add Package", "", "e.g. torch or vllm", "Add");
              const names = (v ?? "").split(/[\s,]+/).filter(Boolean).filter((x) => !cur().studyScope.includes(x));
              if (names.length) A.setSetting("studyScope", [...cur().studyScope, ...names]);
            }}>+ Add Package</button>
          </div>
        </Sec>
        <Sec id="stickers" title="Sticker Packs folder" hint="Iconify JSON files, or folders of SVG, PNG, WebP or GIF images (animated ones play).">
          <div class="st-row">
            <PathField />
            <button class="btn" onClick={() => send({ type: "openStickerDir" })}>Open Folder</button>
          </div>
        </Sec>
        <Sec id="dblclick" title="Double-click on the board" hint="What double-clicking empty space creates.">
          <div class="st-chips">
            <For each={[["text", "Text"], ["note", "Note"], ["code", "Code"], ["none", "Nothing"]] as const}>{([v, lb]) => (
              <button class="st-chip pick" classList={{ on: cur().dblClick === v }} onClick={() => A.setSetting("dblClick", v)}>{lb}</button>
            )}</For>
          </div>
        </Sec>
        <Sec id="shared" title="Boards" hint="A card pasted onto another board can be the same card on both boards (linked: code, version and sidenotes stay in sync) or a copy.">
          <div class="st-sub">Paste onto another board</div>
          <div class="st-chips">
            <For each={[["linked", "Linked"], ["copy", "Copy"]] as const}>{([v, lb]) => (
              <button class="st-chip pick" classList={{ on: cur().pasteOther === v }} onClick={() => A.setSetting("pasteOther", v)}>{lb}</button>
            )}</For>
          </div>
          <div class="st-sub">Update a linked card</div>
          <div class="st-chips">
            <For each={[["ask", "Ask Every Time"], ["all", "All Boards"], ["this", "This Board Only"]] as const}>{([v, lb]) => (
              <button class="st-chip pick" classList={{ on: cur().sharedUpdate === v }} onClick={() => A.setSetting("sharedUpdate", v)}>{lb}</button>
            )}</For>
          </div>
          <div class="st-sub">Sub-board preview</div>
          <div class="st-chips">
            <For each={[["skeleton", "Named Skeleton"], ["title", "Title Only"]] as const}>{([v, lb]) => (
              <button class="st-chip pick" classList={{ on: cur().subPreview === v }} onClick={() => A.setSetting("subPreview", v)}>{lb}</button>
            )}</For>
          </div>
        </Sec>
        <Sec id="questions" title="Questions" hint="When you come back to a board, a hint says how many of its questions are still open.">
          <div class="st-sub">Welcome-back hint</div>
          <div class="st-chips">
            <For each={[["2d", "After 2 Days"], ["always", "Always"], ["off", "Off"]] as const}>{([v, lb]) => (
              <button class="st-chip pick" classList={{ on: cur().welcomeBack === v }} onClick={() => A.setSetting("welcomeBack", v)}>{lb}</button>
            )}</For>
          </div>
        </Sec>
        <Sec id="export" title="Export" hint="Defaults for the Export dialog (HTML snapshot and Markdown). Questions and Board-only notes stay out unless you turn them on.">
          <div class="st-sub">Export by default</div>
          <div class="st-chips">
            <For each={[["board", "Whole Board"], ["sections", "Selected Sections"], ["walk", "Walkthrough"]] as const}>{([v, lb]) => (
              <button class="st-chip pick" classList={{ on: cur().exportScope === v }} onClick={() => A.setSetting("exportScope", v)}>{lb}</button>
            )}</For>
          </div>
          <div class="st-sub">Include open questions</div>
          <div class="st-chips">
            <For each={[[true, "On"], [false, "Off"]] as const}>{([v, lb]) => (
              <button class="st-chip pick" classList={{ on: cur().exportQuestions === v }} onClick={() => A.setSetting("exportQuestions", v)}>{lb}</button>
            )}</For>
          </div>
          <div class="st-sub">Include Board-only notes</div>
          <div class="st-chips">
            <For each={[[true, "On"], [false, "Off"]] as const}>{([v, lb]) => (
              <button class="st-chip pick" classList={{ on: cur().exportBoardOnly === v }} onClick={() => A.setSetting("exportBoardOnly", v)}>{lb}</button>
            )}</For>
          </div>
        </Sec>
        <Sec id="zoom" title="Zoom levels" hint="Below Overview, code turns into outlines. Below Map, cards show only numbers and titles.">
          <div class="st-row">
            <Pct label="Overview below" k="zoomOverview" min={20} max={100} />
            <Pct label="Map below" k="zoomMap" min={5} max={60} />
          </div>
        </Sec>
        <Sec id="diagnostics" title="Troubleshooting" hint="Versions, workspace state and recent log lines, with your home folder shown as ~.">
          <button class="btn" onClick={() => A.copyDiagnostics()}>Copy Diagnostics</button>
        </Sec>
        <Show when={cur().debug}><DebugTune /></Show>
        <Shortcuts />
      </div>
    </div>
  );
}

function Sec(p: { id: string; title: string; hint?: string; children: any }) {
  return (
    <section class="st-sec" data-sec={p.id}>
      <div class="st-h"><h3>{p.title}</h3><Show when={p.hint}><p>{p.hint}</p></Show></div>
      <div class="st-c">{p.children}</div>
    </section>
  );
}

/** 主题小样：同一套变量作用在这一小块上（[data-look] 也能挂在元素上） */
function Swatch(p: { id: string }) {
  return (
    <span class="st-prev" data-look={p.id} aria-hidden="true">
      <span class="sp-sec" />
      <span class="sp-card a"><span class="sp-h"><i class="sp-step" /><i class="sp-t" /></span><i class="sp-l kw" /><i class="sp-l fn" /><i class="sp-l mu" /></span>
      <span class="sp-card b"><span class="sp-h"><i class="sp-t" /></span><i class="sp-l ink" /><i class="sp-l mu" /></span>
      <svg class="sp-edge" viewBox="0 0 100 60" preserveAspectRatio="none"><path d="M46 22 C 56 22, 52 40, 62 40" /></svg>
    </span>
  );
}

const LEVEL: Record<NoteFontLevel, string> = { body: "Body Text", h1: "Heading 1", h2: "Heading 2", h3: "Heading 3", h4: "Heading 4", h5: "Heading 5", h6: "Heading 6" };
const r1 = (v: number) => Math.round(v * 10) / 10;

/** Note 的字号：正文和 H1–H6 一级一行。没改的显示主题的字号（灰色），改过的有 Reset；改了立刻生效（根上的 CSS 变量） */
function NoteFonts() {
  let probe!: HTMLDivElement;
  // 主题给的字号：一张看不见的小样 Note 上把自己设的变量清掉再量（标题的默认值跟着现在的正文走，所以正文那块单独量）
  const [defs, setDefs] = createSignal<Record<NoteFontLevel, number>>();
  const measure = () => {
    const px = (sel: string) => r1(parseFloat(getComputedStyle(probe.querySelector(sel)!).fontSize));
    setDefs(Object.fromEntries(NOTE_FONT_LEVELS.map((k) => [k, px(k === "body" ? ".fp-body" : `.fp-heads ${k}`)])) as Record<NoteFontLevel, number>);
  };
  createEffect(() => { void cur().theme; for (const k of NOTE_FONT_LEVELS) void cur().noteFontSize[k]; measure(); });
  const set = (k: NoteFontLevel, v: number | null) => {
    const [lo, hi] = NOTE_FONT_RANGE[k === "body" ? "body" : "heading"];
    if (v !== null) v = Math.min(hi, Math.max(lo, r1(v)));
    // 正好是主题的字号 = 跟主题（换主题时跟着变）
    if (v !== null && cur().noteFontSize[k] === null && Math.abs(v - (defs()?.[k] ?? -1)) < 0.05) v = null;
    A.setNoteFont(k, v);
  };
  const changed = () => NOTE_FONT_LEVELS.some((k) => cur().noteFontSize[k] !== null);
  const clear = Object.fromEntries(NOTE_FONT_LEVELS.map((k) => [k === "body" ? "--note-fs" : `--note-fs-${k}`, "initial"]));
  return (
    <>
      <div class="st-sub row"><span>Font size</span><span class="grow" />
        <button class="st-reset" disabled={!changed()} onClick={() => A.setNoteFont("all", null)}>Reset All</button>
      </div>
      <div class="st-fonts">
        <For each={NOTE_FONT_LEVELS}>{(k) => {
          const v = () => cur().noteFontSize[k];
          const shown = () => v() ?? defs()?.[k] ?? 0;
          const commit = (inp: HTMLInputElement) => { const n = parseFloat(inp.value); if (Number.isFinite(n)) set(k, n); inp.value = String(shown()); };
          return (
            <div class="st-fr" data-level={k} classList={{ custom: v() !== null }}>
              <span class="st-fl">{LEVEL[k]}</span>
              <span class="st-num">
                <button class="st-step" aria-label={`Smaller ${LEVEL[k]}`} tabIndex={-1} onClick={() => set(k, Math.floor(shown() - 0.5))}>−</button>
                <input type="number" aria-label={`${LEVEL[k]} size`} step={1} value={shown()} onChange={(e) => commit(e.currentTarget)} onKeyDown={(e) => { if (e.key === "Enter") commit(e.currentTarget); }} />px
                <button class="st-step" aria-label={`Larger ${LEVEL[k]}`} tabIndex={-1} onClick={() => set(k, Math.ceil(shown() + 0.5))}>+</button>
              </span>
              <Show when={v() !== null} fallback={<span class="st-def">Theme</span>}>
                <button class="st-x" aria-label={`Reset ${LEVEL[k]}`} data-tip="Reset to the Theme's Size" onClick={() => set(k, null)}><Icon name="undo" size={11} /></button>
              </Show>
            </div>
          );
        }}</For>
      </div>
      <div class="card note st-fprobe" ref={probe} aria-hidden="true">
        <div class="nbody md fp-body" style={{ "--note-fs": "initial" }}><p /></div>
        <div class="nbody md fp-heads" style={Object.fromEntries(Object.entries(clear).filter(([n]) => n !== "--note-fs"))}><h1 /><h2 /><h3 /><h4 /><h5 /><h6 /></div>
      </div>
    </>
  );
}

/** 公式预设：离开输入框（或 ⌘↵）时写回；排不出来的定义列在下面 */
function Preamble() {
  const commit = (v: string) => { if (v !== cur().mathPreamble) A.setSetting("mathPreamble", v); };
  const errs = () => { void mathRev(); return mathPreambleErrors(); };
  return (
    <>
      <textarea class="fld mono st-pre" spellcheck={false} rows={4} value={cur().mathPreamble} aria-label="Math preamble"
        placeholder={"\\newcommand{\\R}{\\mathbb{R}}\n\\newcommand{\\norm}[1]{\\lVert #1 \\rVert}"}
        onChange={(e) => commit(e.currentTarget.value)} onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) e.currentTarget.blur(); }} />
      <For each={errs()}>{(m) => <div class="st-warn">{m}</div>}</For>
    </>
  );
}

/** 每项 AI 功能用哪个模型：Auto、DeepSeek、或某个 VS Code 语言模型（看图的功能只列收图的） */
const AI_FEATURES = [
  ["aiText", "Extract Text, Paste Image Text", true],
  ["aiSvg", "Convert to SVG, Modify SVG", true],
  ["aiFocus", "Auto Focus", false],
] as const;

/** AI：DeepSeek 密钥（只显示设没设）、模型名、灰字补全用谁、各功能的模型、Convert to SVG 的默认项。模型清单和密钥状态问宿主 */
function AiSettings() {
  const [info, setInfo] = createSignal<AiInfo>({ key: false, models: [] });
  const [busy, setBusy] = createSignal(false);
  onMount(() => void ask("aiInfo", {}).then((r) => r && setInfo(r)).catch(() => undefined));
  const keyAction = async (action: "set" | "clear") => {
    setBusy(true);
    try { const r = await ask("aiKey", { action }); if (r) setInfo(r); } catch { /* 宿主没回：状态照旧 */ } finally { setBusy(false); }
  };
  const commitModel = (v: string) => { v = v.trim(); if (v !== cur().deepseekModel) A.setSetting("deepseekModel", v); };
  return (
    <>
      <div class="st-sub">DeepSeek API key</div>
      <div class="st-row st-key">
        <span class="st-ks" classList={{ on: info().key }}>{info().key ? "Set" : "Not set"}</span>
        <button class="btn" disabled={busy()} onClick={() => void keyAction("set")}>Set Key…</button>
        <button class="btn" disabled={busy() || !info().key} onClick={() => void keyAction("clear")}>Clear</button>
      </div>
      <div class="st-sub">DeepSeek model</div>
      <input class="fld mono st-path st-dsm" type="text" spellcheck={false} value={cur().deepseekModel} placeholder="deepseek-flash" aria-label="DeepSeek model"
        onChange={(e) => commitModel(e.currentTarget.value)} onKeyDown={(e) => { if (e.key === "Enter") e.currentTarget.blur(); }} />
      <div class="st-sub">Inline completions in Notes</div>
      <div class="st-chips">
        <For each={[["auto", "Auto"], ["copilot", "VS Code Model"], ["deepseek", "DeepSeek"], ["off", "Off"]] as const}>{([v, lb]) => (
          <button class="st-chip pick" classList={{ on: cur().aiProvider === v }} onClick={() => A.setSetting("aiProvider", v)}>{lb}</button>
        )}</For>
      </div>
      <div class="st-sub">Model for each tool</div>
      <div class="st-models">
        <For each={AI_FEATURES}>{([k, label, vision]) => {
          const auto = () => (info().key ? "DeepSeek" : info().models.some((m) => !vision || m.vision) ? "a VS Code model" : "no model available");
          const known = () => cur()[k] === "auto" || cur()[k] === "deepseek" || info().models.some((m) => m.id === cur()[k]);
          return (
            <label class="st-mr">
              <span class="st-fl">{label}</span>
              <select class="fld sm" data-ai={k} value={cur()[k]} onChange={(e) => A.setSetting(k, e.currentTarget.value)}>
                <option value="auto">Auto ({auto()})</option>
                <option value="deepseek">DeepSeek{info().key ? "" : " (no key set)"}</option>
                <Show when={info().models.length}>
                  <optgroup label="VS Code language models">
                    <For each={info().models}>{(m) => <option value={m.id} disabled={vision && !m.vision}>{m.name} · {m.vendor}{vision && !m.vision ? " (no image input)" : ""}</option>}</For>
                  </optgroup>
                </Show>
                <Show when={!known()}><option value={cur()[k]}>{cur()[k]} (not available)</option></Show>
              </select>
            </label>
          );
        }}</For>
      </div>
      <div class="st-sub">Convert to SVG</div>
      <div class="st-checks">
        <label class="st-check"><input type="checkbox" checked={cur().svgNoBg} onChange={(e) => A.setSetting("svgNoBg", e.currentTarget.checked)} />Remove Background</label>
        <label class="st-check" data-tip="Several times slower, with a more accurate layout. DeepSeek only"><input type="checkbox" checked={cur().svgThink} onChange={(e) => A.setSetting("svgThink", e.currentTarget.checked)} />Think First (slower)</label>
      </div>
    </>
  );
}

function PathField() {
  const commit = (v: string) => { v = v.trim(); if (v !== cur().stickerDir) A.setSetting("stickerDir", v); };
  return <input class="fld mono st-path" type="text" spellcheck={false} value={cur().stickerDir} placeholder="~/.codeboard/stickers" aria-label="Sticker folder"
    onChange={(e) => commit(e.currentTarget.value)} onKeyDown={(e) => { if (e.key === "Enter") e.currentTarget.blur(); }} />;
}

function Pct(p: { label: string; k: "zoomOverview" | "zoomMap"; min: number; max: number }) {
  const commit = (inp: HTMLInputElement) => {
    let v = Math.round(Number(inp.value));
    if (!Number.isFinite(v)) v = Math.round(cur()[p.k] * 100);
    v = Math.min(p.max, Math.max(p.min, v));
    // Map 要比 Overview 小
    if (p.k === "zoomMap") v = Math.min(v, Math.round(cur().zoomOverview * 100) - 5);
    else v = Math.max(v, Math.round(cur().zoomMap * 100) + 5);
    inp.value = String(v);
    if (v / 100 !== cur()[p.k]) A.setSetting(p.k, v / 100);
  };
  return (
    <label class="st-pct">{p.label}
      <span class="st-num"><input type="number" min={p.min} max={p.max} step={5} value={Math.round(cur()[p.k] * 100)} onChange={(e) => commit(e.currentTarget)} onKeyDown={(e) => { if (e.key === "Enter") commit(e.currentTarget); }} />%</span>
    </label>
  );
}

function Shortcuts() {
  const [q, setQ] = createSignal("");
  const mac = () => state.host.isMac;
  const groups = () => helpRows(mac(), q());
  return (
    <section class="st-sec wide" data-sec="shortcuts">
      <div class="st-h row"><h3>Keyboard Shortcuts</h3><span class="st-ro">Read-only</span><span class="grow" />
        <input class="fld st-filter" type="text" placeholder="Filter shortcuts…" value={q()} onInput={(e) => setQ(e.currentTarget.value)} spellcheck={false} />
      </div>
      <div class="st-keys">
        <For each={groups()} fallback={<div class="empty">No shortcut matches “{q()}”.</div>}>{([g, rows]) => (
          <div class="st-kg">
            <h4>{g}</h4>
            <For each={rows}>{([k, a]) => <div class="st-kr"><span>{a}</span><kbd>{k}</kbd></div>}</For>
          </div>
        )}</For>
      </div>
    </section>
  );
}

/** Debug：现调时间、距离这些常量（codeboard.debug.enabled 打开时才有）。改了立刻生效，Reset 回默认 */
function DebugTune() {
  const set = (k: TuneKey, v: number | undefined) => {
    const t = { ...cur().tune };
    t[k] = v ?? TUNE[k].def; // Solid 的 store 合并对象，删 key 删不掉：Reset 就写回默认值
    A.setSetting("tune", t);
  };
  return (
    <section class="st-sec" data-sec="debug">
      <div class="st-h"><h3>Debug</h3><p>Timings and distances. Changes apply right away. Shown because codeboard.debug.enabled is on.</p></div>
      <div class="st-c st-tune">
        <For each={Object.keys(TUNE) as TuneKey[]}>{(k) => (
          <label class="st-tr">
            <span>{TUNE[k].label}</span>
            <input type="range" min={TUNE[k].min} max={TUNE[k].max} value={tune(k)} onInput={(e) => set(k, +e.currentTarget.value)} />
            <code>{tune(k)}{TUNE[k].unit}</code>
            <button class="st-x" aria-label={`Reset ${TUNE[k].label}`} data-tip="Reset" disabled={tune(k) === TUNE[k].def} onClick={() => set(k, undefined)}><Icon name="undo" size={11} /></button>
          </label>
        )}</For>
      </div>
    </section>
  );
}
