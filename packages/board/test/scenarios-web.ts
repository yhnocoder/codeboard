// Web 卡（书签）、Link List、GitHub 链接和 From GitHub… 面板的场景。宿主的网络请求（webMeta、gh）在这里假装回答。
import { open, shot, files, viewOf, put, type Host, type OnMsg } from "./harness";
import { emptyBoard, uid, type Board, type WebCard, type WebMeta, type LinksCard, type CodeCard, type Segment, type GhTree } from "@codeboard/core";

const light = process.argv.includes("--light");
const svg = (s: string) => `data:image/svg+xml;base64,${Buffer.from(s).toString("base64")}`;
const fav = (c: string, t = "") => svg(`<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><rect width="32" height="32" rx="7" fill="${c}"/><text x="16" y="22" font-family="Arial" font-weight="700" font-size="17" fill="#fff" text-anchor="middle">${t}</text></svg>`);
const og = (a: string, b: string, t: string) => svg(`<svg xmlns="http://www.w3.org/2000/svg" width="600" height="315"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${a}"/><stop offset="1" stop-color="${b}"/></linearGradient></defs><rect width="600" height="315" fill="url(#g)"/><text x="40" y="180" font-family="Georgia" font-size="46" fill="#fff">${t}</text></svg>`);

// 假的网页：url → 元信息
const PAGES: Record<string, WebMeta> = {
  "https://arxiv.org/abs/2407.08608": { title: "FlashAttention-3: Fast and Accurate Attention with Asynchrony and Low-precision", desc: "We develop three main techniques to speed up attention on Hopper GPUs: exploiting asynchrony of the Tensor Cores and TMA to overlap overall computation and data movement via warp-specialization, interleaving block-wise matmul and softmax operations.", site: "arXiv.org", icon: fav("#b31b1b", "a"), image: og("#7b1f1f", "#d9822b", "FlashAttention-3") },
  "https://github.com/GeeeekExplorer/nano-vllm": { title: "nano-vllm: A lightweight vLLM implementation built from scratch", desc: "Fast offline inference in ~1,200 lines of readable Python, with prefix caching, tensor parallelism, CUDA graphs and torch compilation.", site: "GitHub", icon: fav("#24292f", "") },
  "https://triton-lang.org/main/python-api/triton.language.html": { title: "Triton Language Reference", icon: fav("#5b7bd5", "T") },
  "https://docs.internal.company/wiki/kv-cache-design/a-very-long-page-name-that-keeps-going-and-going?tab=notes&rev=2025-10-16T04:15:00Z&from=board": { failed: true },
  "https://arxiv.org/abs/2309.06180": { title: "Efficient Memory Management for Large Language Model Serving with PagedAttention", desc: "High throughput serving of large language models (LLMs) requires batching sufficiently many requests at a time. However, existing systems struggle because the key-value cache memory for each request is huge.", site: "arXiv.org", icon: fav("#b31b1b", "a"), image: og("#3b2a6b", "#7a5bd1", "PagedAttention") },
  "https://flashinfer.ai/2024/02/02/cascade-inference.html": { title: "FlashInfer: paged KV layout and cascade inference", desc: "Cascade inference with shared prefix KV-cache.", icon: fav("#e4572e", "F"), image: og("#e4572e", "#f2a541", "FlashInfer") },
  "https://github.com/GeeeekExplorer/nano-vllm/blob/main/nanovllm/engine/block_manager.py": { title: "nano-vllm/nanovllm/engine/block_manager.py", desc: "Block allocation and prefix caching with xxhash.", site: "GitHub", icon: fav("#24292f"), image: og("#24292f", "#57606a", "block_manager.py") },
};
const metaFor = (url: string): WebMeta => ({ ...(PAGES[url] ?? { failed: true }), at: 1 });

const web = (url: string, meta?: WebMeta): WebCard => ({ id: uid("w"), kind: "web", url, meta: meta ?? metaFor(url) });
const close = (h: Host) => h.page.context().browser()!.close();
const paste = (h: Host, text: string, x: number, y: number) => h.page.evaluate(([t, px, py]) => {
  window.dispatchEvent(new PointerEvent("pointermove", { clientX: px as number, clientY: py as number }));
  const dt = new DataTransfer(); dt.setData("text/plain", t as string);
  document.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true }));
}, [text, x, y] as const);

/** webMeta 慢一点回，能看到 Fetching… */
const webHost: OnMsg = async (m, reply) => {
  if (m.type === "webMeta") { setTimeout(() => reply(m.req!, metaFor(m.url)), 350); return true; }
  if (m.type === "openLink") { console.log("openLink", m.url); return true; }
  return false;
};

// ---------- GitHub 假数据：用 nano-vllm 的文件扮演 vllm-project/vllm ----------

const SHA = { main: "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678", "v0.6.0": "0f1e2d3c4b5a69788796a5b4c3d2e1f0a9b8c7d6" } as Record<string, string>;
function ghTree(commit: string): GhTree {
  const ps = new Set<string>();
  const out: GhTree["paths"] = [];
  for (const f of files.keys()) {
    const parts = f.split("/");
    for (let i = 1; i < parts.length; i++) { const d = parts.slice(0, i).join("/"); if (!ps.has(d)) { ps.add(d); out.push({ path: d, dir: true }); } }
    out.push({ path: f });
  }
  out.push({ path: "README.md" }, { path: "pyproject.toml" });
  return { commit, paths: out };
}
function ghCard(owner: string, name: string, commit: string, ref: string, p: string, start: number, end: number): CodeCard {
  const f = files.get(p)!;
  const seg: Segment = { id: uid("s"), src: { kind: "github", owner, name, ref }, path: p, lang: "python", start, end, text: f.text.slice(start - 1, end), version: { kind: "git", commit } };
  return { id: uid("c"), kind: "code", segments: [seg] };
}
const ghHost: OnMsg = async (m, reply) => {
  if (m.type === "paste") {
    // 宿主的 pasteCard：GitHub blob 链接 → 钉 commit 的 GitHub Code 卡
    const g = /github\.com\/([\w.-]+)\/([\w.-]+)\/blob\/([^/]+)\/(\S+?)#L(\d+)-L(\d+)/.exec(m.text);
    if (!g) { await reply(m.req!, null); return true; }
    const c = ghCard(g[1], g[2], SHA.main, g[3], "nanovllm/engine/scheduler.py", +g[5], +g[6]);
    await reply(m.req!, { card: c, views: { [c.segments[0].id]: viewOf(c.segments[0]) }, w: 560 });
    return true;
  }
  if (m.type !== "gh") return webHost(m, reply);
  const q = m.q;
  const later = (d: unknown, ms = 200) => setTimeout(() => reply(m.req!, d), ms);
  switch (q.op) {
    case "repo": later({ owner: q.owner, name: q.name, branch: "main", branches: ["main", "releases/v0.6.0", "dev"], tags: ["v0.6.0", "v0.5.5"], private: false }); break;
    case "commit": { const c = SHA[q.ref] ?? (/^[0-9a-f]{7,40}$/.test(q.ref) ? q.ref.padEnd(40, "0") : undefined); if (!c) reply(m.req!, undefined, `“${q.ref}” not found`); else later({ commit: c, msg: "Fix chunked prefill", date: "2026-10-01" }); break; }
    case "tree": later(ghTree(q.commit)); break;
    case "file": {
      const f = files.get(q.path);
      if (!f) { reply(m.req!, undefined, `${q.path} is not cached in this mock`); break; }
      const seg: Segment = { id: "x", src: { kind: "github", owner: q.owner, name: q.name, ref: "main" }, path: q.path, lang: "python", start: 1, end: f.text.length, text: f.text, version: { kind: "git", commit: q.commit } };
      later({ path: q.path, lang: "python", text: f.text, html: viewOf(seg).html });
      break;
    }
    case "card": { const c = ghCard(q.owner, q.name, q.commit, q.ref, q.path, q.start, q.end); later({ card: c, views: { [c.segments[0].id]: viewOf(c.segments[0]) }, w: 560 }); break; }
  }
  return true;
};

export const WEB: Record<string, () => Promise<void>> = {
  /** 书签的几种样子：完整、没图、只有标题、什么都没有（长网址）、抓取中；双击打开 */
  async web() {
    const b: Board = emptyBoard("b1", "Reading list");
    const urls = Object.keys(PAGES);
    put(b, web(urls[0]), 60, 60, 520);
    put(b, web(urls[1]), 620, 60, 360);
    put(b, web(urls[2]), 1020, 60, 300);
    put(b, web(urls[3]), 620, 260, 360);
    const titled = web(urls[2]); titled.title = "Triton docs (edited title)"; titled.desc = "My own description, edited in place.";
    put(b, titled, 1020, 200, 300);
    put(b, { id: uid("w"), kind: "web", url: "https://example.com/slow" }, 1020, 380, 300); // 还没抓到
    const h = await open({ board: b, light, on: webHost });
    await shot(h, "web-01-states");
    await h.page.locator(".card.web").first().hover(); await h.page.waitForTimeout(200);
    await shot(h, "web-02-hover");
    const t = h.page.locator(".card.web").first().locator(".wtitle");
    await t.dblclick(); await h.page.waitForTimeout(200);
    const opened = h.sent.filter((m) => m.type === "openLink").length;
    // A2 第三种：Edit Title / Retry
    await h.page.locator(".card.web .wlink", { hasText: "Edit Title" }).first().click();
    await h.page.keyboard.type("KV cache design notes"); await h.page.keyboard.press("Enter");
    await h.page.waitForTimeout(200);
    // 粘贴一个网址：先显示 Fetching…，再变成书签
    await paste(h, "https://flashinfer.ai/2024/02/02/cascade-inference.html", 120, 560);
    await h.page.waitForTimeout(120);
    await shot(h, "web-03-fetching");
    await h.page.waitForTimeout(600);
    await shot(h, "web-04-pasted");
    await h.page.waitForTimeout(900);
    const cards = h.board().cards as WebCard[];
    const ok = opened === 1 && cards.some((c) => c.title === "KV cache design notes") && cards.some((c) => c.url.includes("flashinfer") && c.meta?.title);
    console.log(ok ? "PASS" : "FAIL", "web", JSON.stringify({ opened, n: cards.length }));
    await close(h);
  },
  /** Link List：拖到标题上合并、多行粘贴、Compact / Rich、悬停、右键、排序、拖出 */
  /** 五种样式并排；↗ 只在悬停时出现 */
  async webstyles() {
    const b = emptyBoard("b1", "v0.1.5");
    const url = "https://arxiv.org/abs/2309.06180";
    const styles = [undefined, "banner", "side", "text", "compact"] as const;
    const ids = styles.map((st, i) => { const c = { ...web(url), style: st }; put(b, c, 40 + (i % 3) * 400, 40 + Math.floor(i / 3) * 380, 360); return c.id; });
    b.cam = { x: 0, y: 0, z: 1 };
    const h = await open({ board: b, light, w: 1300, h: 820, on: webHost });
    await h.page.waitForTimeout(600);
    const op = (id: string) => h.page.locator(`.card[data-id="${id}"] .wacts`).evaluate((e) => +getComputedStyle(e).opacity);
    const hidden = await op(ids[2]);
    const r = (await h.page.locator(`.card[data-id="${ids[2]}"]`).boundingBox())!;
    await h.page.mouse.move(r.x + 40, r.y + 40); await h.page.waitForTimeout(300);
    const shown = await op(ids[2]);
    const info = await Promise.all(ids.map((id) => h.page.locator(`.card[data-id="${id}"] .wbm`).evaluate((e) => ({ banner: e.classList.contains("wbanner"), compact: e.classList.contains("wcompact"), img: !!e.querySelector(".wimg"), h: Math.round(e.getBoundingClientRect().height) }))));
    await shot(h, "web-styles");
    // 菜单 View ▸ No Image
    await h.page.mouse.click(r.x + 40, r.y + 40, { button: "right" }); await h.page.waitForTimeout(400);
    await h.page.locator(".ctx button", { hasText: /^View/ }).hover(); await h.page.waitForTimeout(400);
    await h.page.locator(".ctx button", { hasText: "No Image" }).click(); await h.page.waitForTimeout(1400);
    const st = (h.board().cards.find((c) => c.id === ids[2]) as WebCard).style;
    const ok = hidden === 0 && shown === 1 && info[1].banner && !info[2].banner && info[2].img && !info[3].img && info[4].compact && !info[4].img && info[4].h < 50 && st === "text";
    console.log(ok ? "PASS" : "FAIL", "web-styles", JSON.stringify({ hidden, shown, info, st }));
    await close(h);
  },
  async linklist() {
    const b: Board = emptyBoard("b1", "KV Cache Reading");
    const a = web("https://arxiv.org/abs/2309.06180"), c = web("https://github.com/GeeeekExplorer/nano-vllm/blob/main/nanovllm/engine/block_manager.py");
    put(b, a, 80, 80, 420); put(b, c, 80, 320, 420);
    const h = await open({ board: b, light, on: webHost });
    // 把第二张拖到第一张的标题上，停一下等它「准备好」，松手合并
    const src = await h.page.locator(`.card[data-id="${c.id}"] .wtitle`).boundingBox();
    const dst = await h.page.locator(`.card[data-id="${a.id}"] .wtitle`).boundingBox();
    await h.page.mouse.move(src!.x + 40, src!.y + 8); await h.page.mouse.down();
    await h.page.mouse.move(dst!.x + 60, dst!.y + 10, { steps: 10 });
    await h.page.waitForTimeout(550);
    await shot(h, "ll-01-merge-armed");
    await h.page.mouse.up(); await h.page.waitForTimeout(300);
    await h.page.waitForTimeout(900); // 等自动保存
    const L = () => h.board().cards.find((k) => k.kind === "links") as LinksCard | undefined;
    const merged = L()?.items.length === 2 && h.board().cards.length === 1;
    // 多行粘贴 → 新的 Link List
    await paste(h, ["https://flashinfer.ai/2024/02/02/cascade-inference.html", "https://docs.internal.company/wiki/kv-cache-design/a-very-long-page-name-that-keeps-going-and-going?tab=notes&rev=2025-10-16T04:15:00Z&from=board", "https://triton-lang.org/main/python-api/triton.language.html"].join("\n"), 700, 120);
    await h.page.waitForTimeout(1200);
    const lists = () => h.board().cards.filter((k) => k.kind === "links") as LinksCard[];
    const pasted = lists().length === 2 && lists()[1].items.length === 3;
    // 合并两张 Link List（多选 → Merge into Link List）
    await h.page.keyboard.press("Control+a");
    await h.page.locator(".card.links .chead").first().click({ button: "right" });
    await h.page.locator(".ctx button", { hasText: "Merge into Link List" }).click(); await h.page.waitForTimeout(300);
    await h.page.mouse.click(1300, 860);
    await shot(h, "ll-02-compact");
    // 悬停 Compact 行：工具条 + 完整书签
    const rows = h.page.locator(".card.links .lrow");
    await rows.nth(2).hover(); await h.page.waitForTimeout(800);
    await shot(h, "ll-03-hover-peek");
    // 单行切到 Rich
    await rows.nth(1).hover(); await rows.nth(1).locator('.ltools .lb[aria-label="Show as Rich"]').click(); await h.page.waitForTimeout(200);
    await rows.nth(0).hover(); await rows.nth(0).locator('.ltools .lb[aria-label="Show as Rich"]').click(); await h.page.waitForTimeout(200);
    await h.page.mouse.move(1300, 860); await h.page.waitForTimeout(200);
    await shot(h, "ll-04-mixed");
    await rows.nth(1).hover(); await h.page.waitForTimeout(250);
    await shot(h, "ll-05-rich-hover");
    // 右键一行
    await rows.nth(3).click({ button: "right" }); await h.page.waitForTimeout(200);
    await shot(h, "ll-06-row-menu");
    await h.page.keyboard.press("Escape");
    // ⋯ → View ▸ Rich
    await h.page.locator(".card.links .chead").click({ button: "right", position: { x: 30, y: 12 } }); await h.page.waitForTimeout(150);
    await h.page.locator(".ctx button", { hasText: "View" }).hover(); await h.page.waitForTimeout(250);
    await shot(h, "ll-06b-view");
    // 子菜单目前画在父菜单坐标系里（Menu.tsx 的老问题，菜单重写时修），这里直接点
    await h.page.locator(".ctx button", { hasText: /^Rich/ }).last().dispatchEvent("click"); await h.page.waitForTimeout(300);
    await h.page.mouse.move(1300, 860);
    await shot(h, "ll-07-all-rich");
    const rich = !!L()?.rich;
    // 拖 ⋮⋮ 排序：第 4 行拖到最前
    await h.page.waitForTimeout(900);
    const order0 = L()!.items.map((x) => x.url);
    await rows.nth(3).hover();
    const g = await rows.nth(3).locator(".lgrip").boundingBox();
    const top = await rows.nth(0).boundingBox();
    await h.page.mouse.move(g!.x + 5, g!.y + 8); await h.page.mouse.down();
    await h.page.mouse.move(g!.x + 5, top!.y + 6, { steps: 8 }); await h.page.waitForTimeout(100);
    await shot(h, "ll-08-reorder");
    await h.page.mouse.up(); await h.page.waitForTimeout(1000);
    const order1 = L()!.items.map((x) => x.url);
    const reordered = order1[0] === order0[3] && order1.length === order0.length;
    // 拖出卡外 = 拆成 Web 卡
    await rows.nth(1).hover();
    const g2 = await rows.nth(1).locator(".lgrip").boundingBox();
    await h.page.mouse.move(g2!.x + 5, g2!.y + 8); await h.page.mouse.down();
    await h.page.mouse.move(320, 420, { steps: 10 }); await h.page.waitForTimeout(100);
    await shot(h, "ll-09-drag-out");
    await h.page.mouse.up(); await h.page.waitForTimeout(400);
    await shot(h, "ll-10-split");
    await h.page.waitForTimeout(600);
    const split = h.board().cards.filter((k) => k.kind === "web").length === 1 && L()!.items.length === order0.length - 1;
    const ok = merged && pasted && rich && reordered && split;
    console.log(ok ? "PASS" : "FAIL", "linklist", JSON.stringify({ merged, pasted, rich, reordered, split }));
    await close(h);
  },
  /** GitHub blob 链接粘贴 → GitHub Code 卡；From GitHub… 面板 */
  async github() {
    const h = await open({ board: emptyBoard("b1", "vllm attention"), light, on: ghHost });
    await paste(h, "https://github.com/vllm-project/vllm/blob/main/nanovllm/engine/scheduler.py#L24-L41", 200, 200);
    await h.page.waitForTimeout(700);
    await shot(h, "gh-01-blob-paste");
    await h.page.waitForTimeout(900);
    const blob = (h.board().cards[0] as CodeCard | undefined)?.segments?.[0];
    const blobOk = blob?.src.kind === "github" && blob.version.kind === "git" && blob.start === 24;
    // 侧栏 Add Repo… → 宿主发 githubPicker
    await h.post({ type: "githubPicker" });
    await h.page.waitForTimeout(200);
    await shot(h, "gh-02-picker-empty");
    await h.page.keyboard.type("vllm-project/vllm"); await h.page.keyboard.press("Enter");
    await h.page.waitForTimeout(900);
    await h.page.locator(".ghp .gt.dir", { hasText: "nanovllm" }).click();
    await h.page.locator(".ghp .gt.dir", { hasText: "layers" }).click();
    await h.page.locator(".ghp .gt", { hasText: "attention.py" }).click();
    await h.page.waitForTimeout(500);
    const l = (n: number) => h.page.locator(`.ghp .gl[data-l="${n}"] .no`);
    await l(30).scrollIntoViewIfNeeded();
    const a = await l(30).boundingBox(), z = await l(36).boundingBox();
    await h.page.mouse.move(a!.x + 10, a!.y + 8); await h.page.mouse.down();
    await h.page.mouse.move(z!.x + 10, z!.y + 8, { steps: 6 }); await h.page.mouse.up();
    await shot(h, "gh-03-picker-file");
    // 换到 tag：commit 跟着变，文件还开着
    await h.page.locator(".ghp-seg button", { hasText: "Tag" }).click(); await h.page.waitForTimeout(900);
    await h.page.locator(".ghp-refin").click(); await h.page.waitForTimeout(150);
    await shot(h, "gh-04-picker-tag");
    await h.page.keyboard.press("Escape");
    await h.page.locator(".ghp .btn.pri", { hasText: "Add to Board" }).click();
    await h.page.waitForTimeout(800);
    await shot(h, "gh-05-added");
    await h.page.waitForTimeout(900);
    const c = h.board().cards[1] as CodeCard | undefined;
    const s = c?.segments[0];
    const ok = blobOk && s?.src.kind === "github" && (s.src as any).ref === "v0.6.0" && (s.version as any).commit === SHA["v0.6.0"] && s.start === 30 && s.end === 36;
    console.log(ok ? "PASS" : "FAIL", "github", JSON.stringify({ blobOk, ref: (s?.src as any)?.ref, start: s?.start, end: s?.end }));
    // 贴链接打开到文件和行
    await h.post({ type: "githubPicker", repo: "https://github.com/vllm-project/vllm/blob/main/nanovllm/engine/block_manager.py#L10-L20" });
    await h.page.waitForTimeout(1300);
    await shot(h, "gh-06-picker-link");
    await close(h);
  },
};
