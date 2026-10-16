// Settings 页：白板里的整窗页面（⌘, / ⋯ → Settings… / 命令 CodeBoard: Open Settings）。
// 改动乐观更新 state.host.settings，宿主写进 codeboard.*；快捷键清单和 ? 浮层共用 shortcuts.ts。
import { For, Show, createEffect, createSignal, onMount } from "solid-js";
import { THEMES, DEFAULT_SETTINGS, type HideFlags, type Settings as S } from "@codeboard/core";
import { state } from "../state/store";
import { settingsOpen } from "../state/ui";
import { send } from "../host";
import * as A from "../actions";
import { Icon } from "./icons";
import { promptText } from "./Menu";
import { filterShortcuts, keyText } from "./shortcuts";
import { TUNE, tune, type TuneKey } from "../state/tune";

const cur = (): S => ({ ...DEFAULT_SETTINGS, ...state.host.settings });

/** 主题同步 + 设置页本身；App 里挂一次 */
export function SettingsLayer() {
  createEffect(() => A.applyLook(state.host.settings?.theme));
  return <Show when={settingsOpen()} keyed>{(o) => <SettingsPage section={o.section} />}</Show>;
}

function SettingsPage(p: { section?: string }) {
  let el!: HTMLDivElement;
  onMount(() => {
    const t = p.section && el.querySelector<HTMLElement>(`[data-sec="${p.section}"]`);
    if (t) t.scrollIntoView({ block: "start" });
    el.focus({ preventScroll: true });
  });
  return (
    <div class="settings" ref={el} tabIndex={-1} role="dialog" aria-label="CodeBoard Settings"
      onPointerDown={(e) => e.stopPropagation()} onWheel={(e) => e.stopPropagation()}
      onKeyDown={(e) => { if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); A.closeSettings(); } }}>
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
              </button>
            )}</For>
          </div>
          <div class="st-sub">When a theme makes cards taller</div>
          <div class="st-chips">
            <For each={[["push", "Push Cards Below Down"], ["overlap", "Allow Overlap"]] as const}>{([v, lb]) => (
              <button class="st-chip pick" classList={{ on: (cur().themeReflow ?? "push") === v }} onClick={() => A.setSetting("themeReflow", v)}>{lb}</button>
            )}</For>
          </div>
        </Sec>
        <Sec id="numbers" title="Flow letters" hint="The A, B… on cards that shows which flow they belong to.">
          <label class="st-check"><input type="checkbox" checked={!!cur().hideNumbers} onChange={(e) => A.setSetting("hideNumbers", e.currentTarget.checked || undefined)} />Hide Flow Letters</label>
        </Sec>
        <Sec id="hide" title="New cards hide" hint="What new code cards start with hidden. Each card can still toggle them.">
          <div class="st-checks">
            <For each={[["comments", "Comments"], ["docstrings", "Docstrings"], ["blank", "Blank Lines"]] as [keyof HideFlags, string][]}>{([k, lb]) => (
              <label class="st-check"><input type="checkbox" checked={!!cur().hideOnNew?.[k]} onChange={(e) => A.setSetting("hideOnNew", { ...cur().hideOnNew, [k]: e.currentTarget.checked })} />{lb}</label>
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
        <Sec id="stickers" title="Sticker Packs folder" hint="Iconify JSON files, or folders of SVGs.">
          <div class="st-row">
            <PathField />
            <button class="btn" onClick={() => send({ type: "openStickerDir" })}>Open Folder</button>
          </div>
        </Sec>
        <Sec id="dblclick" title="Double-click on the board" hint="What double-clicking empty space creates.">
          <div class="st-chips">
            <For each={[["text", "Text"], ["note", "Note"], ["code", "Code"], ["none", "Nothing"]] as const}>{([v, lb]) => (
              <button class="st-chip pick" classList={{ on: (cur().dblClick ?? "text") === v }} onClick={() => A.setSetting("dblClick", v)}>{lb}</button>
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

function PathField() {
  const commit = (v: string) => { v = v.trim(); if (v !== cur().stickerDir) A.setSetting("stickerDir", v); };
  return <input class="fld mono st-path" type="text" spellcheck={false} value={cur().stickerDir} placeholder="~/.codeboard/stickers"
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
  const groups = () => filterShortcuts(q(), mac());
  return (
    <section class="st-sec wide" data-sec="shortcuts">
      <div class="st-h row"><h3>Keyboard Shortcuts</h3><span class="st-ro">Read-only</span><span class="grow" />
        <input class="fld st-filter" type="text" placeholder="Filter shortcuts…" value={q()} onInput={(e) => setQ(e.currentTarget.value)} spellcheck={false} />
      </div>
      <div class="st-keys">
        <For each={groups()} fallback={<div class="empty">No shortcut matches “{q()}”.</div>}>{([g, rows]) => (
          <div class="st-kg">
            <h4>{g}</h4>
            <For each={rows}>{([k, a]) => <div class="st-kr"><span>{a}</span><kbd>{keyText(k, mac())}</kbd></div>}</For>
          </div>
        )}</For>
      </div>
    </section>
  );
}

/** Debug：现调时间、距离这些常量（codeboard.debug.enabled 打开时才有）。改了立刻生效，Reset 回默认 */
function DebugTune() {
  const set = (k: TuneKey, v: number | undefined) => {
    const t = { ...(cur().tune ?? {}) };
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
