// 导出的 HTML 里跑的查看脚本：只读，平移（拖、滚轮）、缩放（⌘ / Ctrl + 滚轮、按钮）、适应窗口、讲解路径一步步走、悬停看 Sidenote 和问题、复制代码、打开永久链接。
// 单独打包成一段 IIFE（vite.config 的 ?script），导出时整段写进页面；数据在页面里的 #xv-data（JSON）。不能 import 白板的代码
export type Rect = { x: number; y: number; w: number; h: number };
export type ViewerData = {
  name: string;
  box: Rect;
  walk: { id: string; title: string; mark: string; r: Rect }[];
  notes: Record<string, string>;
  questions: Record<string, string>;
  links: Record<string, string>;
  info: string;
};

function start(d: ViewerData) {
  const board = document.getElementById("board")!, world = board.querySelector(".world") as HTMLElement;
  const q = <T extends Element = HTMLElement>(s: string) => document.querySelector(s) as T;
  q(".xv-info").textContent = d.info;
  let x = 0, y = 0, z = 1;
  const apply = () => { world.style.transform = `translate(${x}px, ${y}px) scale(${z})`; q(".xv-zoom").textContent = `${Math.round(z * 100)}%`; };
  const fit = (r: Rect, maxZ = 1) => {
    const W = board.clientWidth, H = board.clientHeight, pad = 60;
    z = Math.max(0.05, Math.min(maxZ, (W - pad * 2) / r.w, (H - pad * 2) / r.h));
    x = W / 2 - (r.x + r.w / 2) * z; y = H / 2 - (r.y + r.h / 2) * z; apply();
  };
  const zoomAt = (f: number, px = board.clientWidth / 2, py = board.clientHeight / 2) => {
    const nz = Math.max(0.05, Math.min(4, z * f));
    x = px - ((px - x) * nz) / z; y = py - ((py - y) * nz) / z; z = nz; apply();
  };
  fit(d.box);
  board.addEventListener("wheel", (e) => {
    e.preventDefault();
    if (e.ctrlKey || e.metaKey) zoomAt(Math.exp(-e.deltaY * 0.01), e.clientX, e.clientY);
    else { x -= e.deltaX; y -= e.deltaY; apply(); }
  }, { passive: false });
  // 拖空白处、卡头平移；代码和文字里拖是选字（复制）
  let drag: { sx: number; sy: number; x: number; y: number } | null = null;
  board.addEventListener("pointerdown", (e) => {
    const t = e.target as HTMLElement;
    if (e.button !== 0 || t.closest(".src, .md, a, button, .mk, .stk, pre, input")) return;
    drag = { sx: e.clientX, sy: e.clientY, x, y }; board.classList.add("grab"); board.setPointerCapture(e.pointerId);
  });
  board.addEventListener("pointermove", (e) => { if (!drag) return; x = drag.x + e.clientX - drag.sx; y = drag.y + e.clientY - drag.sy; apply(); });
  board.addEventListener("pointerup", () => { drag = null; board.classList.remove("grab"); });
  document.querySelectorAll<HTMLElement>("[data-z]").forEach((b) => b.addEventListener("click", () => { const k = b.dataset.z; if (k === "in") zoomAt(1.25); else if (k === "out") zoomAt(0.8); else fit(d.box); }));
  window.addEventListener("keydown", (e) => {
    if ((e.metaKey || e.ctrlKey) && (e.key === "=" || e.key === "+")) { e.preventDefault(); zoomAt(1.25); }
    else if ((e.metaKey || e.ctrlKey) && e.key === "-") { e.preventDefault(); zoomAt(0.8); }
    else if (e.key === "!" || (e.shiftKey && e.key === "1")) fit(d.box);
    else if (e.key === "ArrowRight") step(1);
    else if (e.key === "ArrowLeft") step(-1);
  });
  // 讲解路径
  let wi = -1;
  const wbar = q(".xv-walk");
  const step = (k: number) => {
    if (!d.walk.length) return;
    wi = Math.max(0, Math.min(d.walk.length - 1, wi + k));
    const s = d.walk[wi];
    document.querySelectorAll(".xv-cur").forEach((e) => e.classList.remove("xv-cur"));
    document.querySelector(`.card[data-id="${s.id}"]`)?.classList.add("xv-cur");
    q(".xv-wt").textContent = `${s.mark ? `${s.mark} · ` : ""}${s.title}`;
    q(".xv-walk .cnt").textContent = `${wi + 1} / ${d.walk.length}`;
    fit(s.r);
  };
  if (d.walk.length > 1) {
    wbar.hidden = false;
    q(".xv-wt").textContent = `▶ Walk Through${d.walk[0].mark ? ` ${d.walk[0].mark}` : ""}`;
    q(".xv-walk .cnt").textContent = `${d.walk.length} steps`;
    wbar.querySelectorAll<HTMLElement>("[data-w]").forEach((b) => b.addEventListener("click", () => step(b.dataset.w === "next" ? 1 : -1)));
    q(".xv-wt").addEventListener("click", () => { if (wi < 0) step(1); });
  }
  // 悬停：Sidenote 标记、问题贴纸
  const tip = q(".xv-tip");
  let hideT: number | undefined;
  const show = (el: HTMLElement, html: string) => {
    clearTimeout(hideT);
    tip.innerHTML = html; tip.hidden = false;
    const r = el.getBoundingClientRect();
    tip.style.left = `${Math.min(r.right + 8, window.innerWidth - 400)}px`; tip.style.top = `${Math.max(8, Math.min(r.top, window.innerHeight - tip.offsetHeight - 8))}px`;
  };
  board.addEventListener("pointerover", (e) => {
    const t = e.target as HTMLElement;
    const mk = t.closest<HTMLElement>("[data-notes]"), st = t.closest<HTMLElement>("[data-sticker]");
    if (mk) { const h = mk.dataset.notes!.split(",").map((id) => d.notes[id]).filter(Boolean).join("<hr>"); if (h) show(mk, h); }
    else if (st && d.questions[st.dataset.sticker!]) show(st, d.questions[st.dataset.sticker!]);
  });
  board.addEventListener("pointerout", (e) => { if ((e.target as HTMLElement).closest("[data-notes], [data-sticker]")) hideT = window.setTimeout(() => { tip.hidden = true; }, 200); });
  tip.addEventListener("pointerenter", () => clearTimeout(hideT));
  tip.addEventListener("pointerleave", () => { tip.hidden = true; });
  // 复制代码、打开永久链接
  board.addEventListener("click", (e) => {
    const t = e.target as HTMLElement;
    const card = t.closest<HTMLElement>(".card[data-id]");
    if (!card) return;
    if (t.closest(".cpy")) {
      const text = [...card.querySelectorAll(".src .l")].map((l) => l.textContent ?? "").join("\n");
      void navigator.clipboard?.writeText(text);
    } else if (t.closest(".cpath") && d.links[card.dataset.id!]) window.open(d.links[card.dataset.id!], "_blank", "noopener");
  });
  window.addEventListener("resize", () => apply());
}

start(JSON.parse(document.getElementById("xv-data")!.textContent!) as ViewerData);
