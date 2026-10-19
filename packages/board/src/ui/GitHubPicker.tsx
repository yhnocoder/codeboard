// From GitHub…：输入 owner/repo（或贴链接）→ 选分支 / tag / commit（加卡时钉成 commit）→ 浏览文件树 → 打开文件选行 → Add to Board。
// 数据都由宿主走 GitHub REST API 拿（私有仓库用 VS Code 的 GitHub 登录，被拒时才请用户登录）。
import { keepKey } from "./editkeys";
import { For, Show, createMemo, createSignal, onMount, batch } from "solid-js";
import { parseRepoInput, type Commit, type GhFile, type GhQuery, type GhReplyOf, type GhRepo, type GhTree, type RepoInput } from "@codeboard/core";
import { toast } from "../state/store";
import { ask } from "../host";
import { Icon } from "./icons";
import * as A from "../actions";
import "./github.css";

type Mode = "branch" | "tag" | "commit";
type Node = { dirs: string[]; files: string[] };
const gh = <Q extends GhQuery>(q: Q) => ask("gh", { q }) as Promise<GhReplyOf<Q["op"]>>;
const base = (p: string) => p.split("/").pop() ?? p;

export function GitHubPicker() {
  const init = A.ghPicker() || {};
  const [text, setText] = createSignal(init.repo ?? "");
  const [repo, setRepo] = createSignal<GhRepo | null>(null);
  const [mode, setMode] = createSignal<Mode>("branch");
  const [ref, setRef] = createSignal("");
  const [refOpen, setRefOpen] = createSignal(false);
  const [commit, setCommit] = createSignal<Commit | null>(null);
  const [tree, setTree] = createSignal<GhTree | null>(null);
  const [open, setOpen] = createSignal<Set<string>>(new Set());
  const [filter, setFilter] = createSignal("");
  const [file, setFile] = createSignal<GhFile | null>(null);
  const [sel, setSel] = createSignal<[number, number] | null>(null);
  const [busy, setBusy] = createSignal("");
  const [err, setErr] = createSignal("");
  let inp!: HTMLInputElement, codeEl!: HTMLDivElement;
  let n = 0; // 只认最后一次请求
  const close = () => A.setGhPicker(false);
  const run = async <T,>(what: string, f: () => Promise<T>): Promise<T | undefined> => {
    const my = ++n;
    setBusy(what); setErr("");
    try { const r = await f(); return my === n ? r : undefined; }
    catch (e) { if (my === n) setErr((e as Error).message); return undefined; }
    finally { if (my === n) setBusy(""); }
  };

  onMount(() => { inp.focus(); inp.select(); if (text().trim()) void openRepo(); });

  /** 打开仓库：输入里带了 ref / 路径 / 行号就一路打开到那里 */
  async function openRepo() {
    const r: RepoInput | null = parseRepoInput(text());
    if (!r) { setErr("Enter owner/repo, or paste a GitHub link."); return; }
    const info = await run(`Opening ${r.owner}/${r.name}…`, () => gh({ op: "repo", owner: r.owner, name: r.name }));
    if (!info) return;
    batch(() => { setRepo(info); setTree(null); setFile(null); setSel(null); setFilter(""); setOpen(new Set<string>()); });
    // 分支名带 / 时链接里分不清 ref 和路径：按已知分支 / tag 的最长前缀拆
    let want = r.ref ?? info.branch, path = r.path;
    if (r.ref && r.path) {
      const full = `${r.ref}/${r.path}`;
      const hit = [...info.branches, ...info.tags].filter((x) => full.startsWith(x + "/")).sort((a, b) => b.length - a.length)[0];
      if (hit && hit.length > r.ref.length) { want = hit; path = full.slice(hit.length + 1); }
    }
    const m: Mode = info.tags.includes(want) && !info.branches.includes(want) ? "tag" : info.branches.includes(want) ? "branch" : /^[0-9a-f]{7,40}$/i.test(want) ? "commit" : "branch";
    batch(() => { setMode(m); setRef(want); });
    await loadRef(want, path, r.start ? [r.start, r.end ?? r.start] : undefined);
  }

  /** ref → commit → 文件树 */
  async function loadRef(want: string, path?: string, lines?: [number, number]) {
    const R = repo();
    if (!R || !want.trim()) return;
    setRefOpen(false);
    const c = await run(`Resolving ${want}…`, () => gh({ op: "commit", owner: R.owner, name: R.name, ref: want.trim() }));
    if (!c) return;
    setCommit(c);
    const t = await run("Loading files…", () => gh({ op: "tree", owner: R.owner, name: R.name, commit: c.commit }));
    if (!t) return;
    setTree(t);
    if (!path) { if (file() && t.paths.some((p) => p.path === file()!.path)) await openFile(file()!.path, sel() ?? undefined); else setFile(null); return; }
    const hit = t.paths.find((p) => p.path === path);
    expandTo(hit?.dir ? path : path.split("/").slice(0, -1).join("/"));
    if (hit && !hit.dir) await openFile(path, lines);
  }

  function expandTo(dir: string) {
    const s = new Set(open());
    const parts = dir ? dir.split("/") : [];
    for (let i = 1; i <= parts.length; i++) s.add(parts.slice(0, i).join("/"));
    setOpen(s);
  }

  async function openFile(path: string, lines?: [number, number]) {
    const R = repo(), c = commit();
    if (!R || !c) return;
    const f = await run(`Opening ${base(path)}…`, () => gh({ op: "file", owner: R.owner, name: R.name, commit: c.commit, ref: refLabel(), path }));
    if (!f) return;
    batch(() => { setFile(f); setSel(lines ? [Math.min(...lines), Math.min(f.text.length, Math.max(...lines))] : null); });
    requestAnimationFrame(() => {
      const el = lines && codeEl?.querySelector(`[data-l="${lines[0]}"]`);
      if (el) (el as HTMLElement).scrollIntoView({ block: "center" }); else codeEl?.scrollTo(0, 0);
    });
  }

  const refLabel = () => (mode() === "commit" ? commit()?.commit ?? ref() : ref());

  async function add() {
    const R = repo(), c = commit(), f = file();
    if (!R || !c || !f) return;
    const [s, e] = sel() ?? [1, Math.min(f.text.length, 60)];
    const card = await run("Adding…", () => gh({ op: "card", owner: R.owner, name: R.name, commit: c.commit, ref: refLabel(), path: f.path, start: s, end: e }));
    if (!card) return;
    close();
    A.addCards([card], { besideSel: false });
    toast(`Added ${base(f.path)} ${s}–${e} · pinned to ${c.commit.slice(0, 7)}`);
  }

  // ---------- 文件树 ----------

  const nodes = createMemo(() => {
    const m = new Map<string, Node>([["", { dirs: [], files: [] }]]);
    const t = tree();
    if (!t) return m;
    const get = (d: string) => { let x = m.get(d); if (!x) m.set(d, (x = { dirs: [], files: [] })); return x; };
    for (const p of t.paths) {
      const i = p.path.lastIndexOf("/"), dir = i < 0 ? "" : p.path.slice(0, i);
      p.dir ? get(dir).dirs.push(p.path) : get(dir).files.push(p.path);
      if (p.dir) get(p.path);
    }
    for (const x of m.values()) { x.dirs.sort(); x.files.sort(); }
    return m;
  });
  const found = createMemo(() => {
    const q = filter().trim().toLowerCase();
    if (!q || !tree()) return null;
    return tree()!.paths.filter((p) => !p.dir && p.path.toLowerCase().includes(q)).slice(0, 200).map((p) => p.path);
  });
  const toggle = (d: string) => { const s = new Set(open()); s.has(d) ? s.delete(d) : s.add(d); setOpen(s); };
  const Dir = (p: { dir: string; depth: number }) => (
    <>
      <For each={nodes().get(p.dir)?.dirs ?? []}>{(d) => (
        <>
          <button class="gt dir" style={{ "padding-left": `${8 + p.depth * 14}px` }} onClick={() => toggle(d)}>
            <span class="tw">{open().has(d) ? "▾" : "▸"}</span>{base(d)}
          </button>
          <Show when={open().has(d)}><Dir dir={d} depth={p.depth + 1} /></Show>
        </>
      )}</For>
      <For each={nodes().get(p.dir)?.files ?? []}>{(f) => (
        <button class="gt" classList={{ on: file()?.path === f }} style={{ "padding-left": `${22 + p.depth * 14}px` }} onClick={() => openFile(f)}>{base(f)}</button>
      )}</For>
    </>
  );

  // ---------- 选行：按下拖过行号 / 代码选范围，⇧ 点击扩展 ----------

  let anchor = 0, down = false;
  const lineDown = (e: PointerEvent, l: number) => {
    if (e.button !== 0) return;
    e.preventDefault();
    down = true;
    if (e.shiftKey && sel()) { const [a, b] = sel()!; anchor = Math.abs(l - a) > Math.abs(l - b) ? a : b; } else anchor = l;
    setSel([Math.min(anchor, l), Math.max(anchor, l)]);
    const up = () => { down = false; window.removeEventListener("pointerup", up, true); };
    window.addEventListener("pointerup", up, true);
  };
  const lineOver = (l: number) => { if (down) setSel([Math.min(anchor, l), Math.max(anchor, l)]); };
  const inSel = (l: number) => { const s = sel(); return !!s && l >= s[0] && l <= s[1]; };

  const refCands = createMemo(() => {
    const R = repo();
    if (!R || mode() === "commit") return [];
    const all = mode() === "branch" ? R.branches : R.tags;
    const q = ref().trim().toLowerCase();
    const hit = all.filter((x) => x.toLowerCase().includes(q));
    return (hit.length ? hit : all).slice(0, 60);
  });
  const setModeTo = (m: Mode) => {
    const R = repo();
    if (!R || m === mode()) return;
    setMode(m);
    if (m === "branch") { setRef(R.branch); void loadRef(R.branch); }
    else if (m === "tag") { setRef(R.tags[0] ?? ""); if (R.tags[0]) void loadRef(R.tags[0]); else setRefOpen(true); }
    else { setRef(commit()?.commit.slice(0, 12) ?? ""); }
  };

  const onKey = (e: KeyboardEvent) => {
    keepKey(e);
    if (e.key === "Escape") { e.preventDefault(); if (refOpen()) setRefOpen(false); else close(); }
    else if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && file()) { e.preventDefault(); void add(); }
  };

  return (
    <div class="scrim light" onPointerDown={(e) => { if (e.target === e.currentTarget) close(); }}>
      <div class="ghp" onKeyDown={onKey} onPointerDown={() => setRefOpen(false)} onContextMenu={(e) => e.preventDefault()}>
        <div class="ghp-top">
          <span class="ghp-ic">GH</span>
          <input ref={inp} class="ghp-in" placeholder="owner/repo, or paste a GitHub link" value={text()} spellcheck={false}
            onInput={(e) => setText(e.currentTarget.value)} onKeyDown={(e) => { if (e.key === "Enter" && !e.isComposing) { e.preventDefault(); void openRepo(); } }} />
          <button class="btn" onClick={() => openRepo()}>Open</button>
          <button class="ib" aria-label="Close" data-tip="Close" data-kbd="Esc" onClick={close}><Icon name="close" size={14} /></button>
        </div>
        <Show when={repo()}>
          <div class="ghp-ref">
            <span class="ghp-repo">{repo()!.owner}/<b>{repo()!.name}</b></span>
            <Show when={repo()!.private}><span class="ghp-badge">Private</span></Show>
            <div class="ghp-seg">
              <For each={[["branch", "Branch"], ["tag", "Tag"], ["commit", "Commit"]] as const}>{([m, lb]) => (
                <button classList={{ on: mode() === m }} disabled={m === "tag" && !repo()!.tags.length} onClick={() => setModeTo(m)}>{lb}</button>
              )}</For>
            </div>
            <div class="ghp-refbox" onPointerDown={(e) => e.stopPropagation()}>
              <input class="ghp-refin" value={ref()} spellcheck={false} placeholder={mode() === "commit" ? "Commit SHA" : mode() === "tag" ? "Tag" : "Branch"}
                onFocus={(e) => { if (mode() !== "commit") setRefOpen(true); e.currentTarget.select(); }} onInput={(e) => { setRef(e.currentTarget.value); if (mode() !== "commit") setRefOpen(true); }}
                onKeyDown={(e) => { if (e.key === "Enter" && !e.isComposing) { e.preventDefault(); e.stopPropagation(); const pick = refOpen() && !refCands().includes(ref()) ? refCands()[0] : undefined; if (pick) setRef(pick); void loadRef(pick ?? ref()); } }} />
              <Show when={refOpen() && refCands().length}>
                <div class="ghp-refs">
                  <For each={refCands()}>{(x) => <button class="cand" classList={{ on: x === ref() }} onClick={() => { setRef(x); void loadRef(x); }}><span class="lb">{x}</span><Show when={x === repo()!.branch && mode() === "branch"}><small>default</small></Show></button>}</For>
                </div>
              </Show>
            </div>
            <Show when={commit()}><span class="ghp-pin" data-tip={commit()!.msg}>{mode() === "commit" ? "" : `${ref()} · `}<code>{commit()!.commit.slice(0, 7)}</code> <span>(pinned on add)</span></span></Show>
          </div>
        </Show>
        <Show when={busy() || err()}><div class="ghp-status" classList={{ err: !!err() && !busy() }}>{busy() || err()}</div></Show>
        <Show when={repo()} fallback={
          <div class="ghp-empty">
            <p>Open a repo, pick a branch, tag or commit, then choose a file and the lines to add.</p>
            <p class="dim">Cards are pinned to the commit. Private repos use your GitHub sign-in in VS Code.</p>
          </div>
        }>
          <div class="ghp-body">
            <div class="ghp-tree">
              <input class="ghp-filter" placeholder="Go to file" value={filter()} spellcheck={false} onInput={(e) => setFilter(e.currentTarget.value)}
                onKeyDown={(e) => { if (e.key === "Enter" && found()?.[0]) { e.preventDefault(); void openFile(found()![0]); } }} />
              <div class="ghp-list">
                <Show when={found()} fallback={<><div class="gt root">{repo()!.name}</div><Dir dir="" depth={0} /></>}>
                  <For each={found()!}>{(f) => <button class="gt" classList={{ on: file()?.path === f }} onClick={() => openFile(f)}><span class="fp">{f}</span></button>}</For>
                  <Show when={!found()!.length}><div class="empty">No matching files</div></Show>
                </Show>
                <Show when={tree()?.truncated}><div class="empty">This repo is large; some files are not listed. Use a link to open them.</div></Show>
              </div>
            </div>
            <div class="ghp-file">
              <Show when={file()} fallback={<div class="ghp-ph">Choose a file on the left</div>}>
                <div class="ghp-fh"><span class="fp">{file()!.path}</span><span class="grow" /><small>{file()!.text.length} lines</small></div>
                <div ref={codeEl} class="ghp-code" onWheel={(e) => e.stopPropagation()}>
                  <For each={file()!.html}>{(h, i) => (
                    <div class="gl" classList={{ on: inSel(i() + 1) }} data-l={i() + 1} onPointerDown={(e) => lineDown(e, i() + 1)} onPointerEnter={() => lineOver(i() + 1)}>
                      <span class="no">{i() + 1}</span><span class="t" innerHTML={h || "​"} />
                    </div>
                  )}</For>
                </div>
              </Show>
            </div>
          </div>
          <div class="ghp-foot">
            <span class="dim">{file() ? (sel() ? `Lines ${sel()![0]}–${sel()![1]} · ${base(file()!.path)}` : "Drag over lines to select · Shift-click to extend") : "Files are cached locally and listed under GitHub Files"}</span>
            <span class="grow" />
            <button class="btn" onClick={close}>Cancel</button>
            <button class="btn pri" disabled={!file() || !!busy()} data-tip={sel() ? undefined : "No lines selected: adds the top of the file"} onClick={() => add()}>Add to Board</button>
          </div>
        </Show>
      </div>
    </div>
  );
}
