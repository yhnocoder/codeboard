// Mermaid 图：页面上有 ```mermaid 块时才加载 mermaid；同一段源码 + 同一主题的 SVG 缓存起来
type M = typeof import("mermaid").default;
let lib: Promise<M> | undefined;
const svgs = new Map<string, Promise<string>>();
let n = 0;

// mermaid 的主题变量要真颜色，从当前主题的 CSS 变量取
function colors() {
  const cs = getComputedStyle(document.documentElement);
  const v = (k: string) => cs.getPropertyValue(k).trim();
  return { dark: document.documentElement.dataset.theme === "dark", ink: v("--ink"), ink2: v("--ink-2"), line: v("--hair"), surface: v("--surface"), head: v("--head"), accent: v("--accent"), font: v("--sys") };
}
async function load(): Promise<M> {
  lib ??= import("mermaid").then((m) => m.default);
  return lib;
}
async function svgOf(src: string): Promise<string> {
  const c = colors();
  const key = `${JSON.stringify(c)}\n${src}`;
  let p = svgs.get(key);
  if (!p) {
    p = (async () => {
      const m = await load();
      m.initialize({
        startOnLoad: false, securityLevel: "strict", theme: "base", fontFamily: c.font,
        themeVariables: { darkMode: c.dark, background: c.surface, primaryColor: c.head, primaryTextColor: c.ink, primaryBorderColor: c.line, lineColor: c.ink2, secondaryColor: c.surface, tertiaryColor: c.surface, textColor: c.ink, mainBkg: c.head, nodeBorder: c.ink2, clusterBkg: c.surface, edgeLabelBackground: c.surface },
      });
      await m.parse(src); // 语法错误在这里抛出，显示错误而不是一片空白
      const { svg } = await m.render(`cbmmd${++n}`, src);
      return svg;
    })();
    svgs.set(key, p);
    p.catch(() => svgs.delete(key));
  }
  return p;
}

// 换主题（html 的 data-look / data-theme）后，已经画好的图按新颜色重画（缓存里没有的才真去画）
let watching = false;
function watchTheme() {
  if (watching) return;
  watching = true;
  let t: number | undefined;
  new MutationObserver(() => {
    clearTimeout(t);
    t = window.setTimeout(() => {
      const hosts = new Set<HTMLElement>();
      for (const box of document.querySelectorAll<HTMLElement>(".mmd[data-done]")) {
        delete box.dataset.done;
        box.classList.remove("ok");
        box.querySelector(".mmd-err")?.remove();
        if (box.parentElement) hosts.add(box.parentElement);
      }
      for (const h of hosts) void renderAll(h);
    }, 50); // 等主题的样式落定再取颜色
  }).observe(document.documentElement, { attributes: true, attributeFilter: ["data-look", "data-theme"] });
}

/** 把 el 里的 .mmd 占位换成图 */
export async function renderAll(el: HTMLElement) {
  watchTheme();
  for (const box of el.querySelectorAll<HTMLElement>(".mmd:not([data-done])")) {
    box.dataset.done = "1";
    const src = box.dataset.src ?? "";
    try {
      const svg = await svgOf(src);
      if (box.isConnected) { box.innerHTML = svg; box.classList.add("ok"); }
    } catch (e) {
      if (!box.isConnected) continue;
      const err = document.createElement("div");
      err.className = "mmd-err";
      err.textContent = `Mermaid: ${String((e as Error)?.message ?? e).split("\n").slice(0, 3).join(" ")}`;
      box.prepend(err);
    }
  }
}
