// 样式顺序和初始化照抄 src/index.tsx，不然样子和插件里不一样；不 render、不发 ready，白板由 story 的 Stage 挂上、喂数据
// 假宿主要在白板的模块发第一条消息之前装好
import "../stories/support/host";
import type { Preview } from "storybook-solidjs-vite";
import { createJSXDecorator } from "storybook-solidjs-vite";
import { createEffect } from "solid-js";
import { onHost } from "../src/hostio";
import { installKeys } from "../src/interact";
import { listen, followHostTheme } from "../src/host";
import { setRefResolver, setCodeHighlighter } from "@yhnocoder/markdown";
import { langId, THEMES, EXPERIMENTAL_THEMES } from "@codeboard/core";
import { noteHighlight } from "../src/cm/load";
import { resolveCardRef } from "../src/actions";
import type { Globals } from "../stories/support/board";
import "@yhnocoder/markdown/katex.css";
import "../src/fonts.css";
import "../src/styles.css";
import "@yhnocoder/markdown/style.css";
import "../src/themes.css";
import "../src/settings.css";

listen(onHost);
installKeys();
setRefResolver(resolveCardRef, { missing: "No card with this title on the board" });
setCodeHighlighter(noteHighlight, langId);
followHostTheme();

// 亮暗挂在 body 的 class 上，和 VS Code 一样，由 followHostTheme 换成 html[data-theme]
const scheme = createJSXDecorator((Story, ctx) => {
  const g = ctx.globals as Globals;
  createEffect(() => {
    const c = document.body.classList;
    c.toggle("vscode-light", g.scheme === "light");
    c.toggle("vscode-dark", g.scheme !== "light");
  });
  return <Story />;
});

const preview: Preview = {
  decorators: [scheme],
  parameters: {
    layout: "fullscreen",
    viewport: { options: { narrow: { name: "Beside the editor (600px)", styles: { width: "600px", height: "800px" } } } },
  },
  globalTypes: {
    theme: {
      description: "Theme",
      toolbar: { title: "Theme", icon: "paintbrush", dynamicTitle: true, items: THEMES.map(([value, name]) => ({ value, title: EXPERIMENTAL_THEMES.includes(value) ? `${name} (Experimental)` : name })) },
    },
    scheme: {
      description: "Light or dark",
      toolbar: { title: "Light / Dark", icon: "mirror", dynamicTitle: true, items: [{ value: "light", title: "Light", icon: "sun" }, { value: "dark", title: "Dark", icon: "moon" }] },
    },
    // 分档的门槛是 settings.zoomOverview = 0.6、zoomMap = 0.25（不含）：60% 正好还是完整的卡，30% 是概览，地图档要 25% 以下
    zoom: {
      description: "Zoom",
      toolbar: { title: "Zoom", icon: "zoom", dynamicTitle: true, items: [{ value: "100", title: "100% · full" }, { value: "60", title: "60% · full (threshold)" }, { value: "30", title: "30% · overview" }] },
    },
  },
  initialGlobals: { theme: "warm-ink", scheme: "light", zoom: "100" },
};
export default preview;
