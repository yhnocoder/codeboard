// 样式顺序和初始化照抄 src/index.tsx，不然样子和插件里不一样；不 render、不发 ready，白板由 story 的 Stage 挂上、喂数据
// 假宿主要在白板的模块发第一条消息之前装好
import "../stories/support/host";
import type { Preview, Decorator } from "storybook-solidjs-vite";
import { addons, useGlobals } from "storybook/preview-api";
import { STORY_CHANGED, UPDATE_GLOBALS } from "storybook/internal/core-events";
import { createJSXDecorator } from "storybook-solidjs-vite";
import { createEffect } from "solid-js";
import { onHost } from "../src/hostio";
import { installKeys } from "../src/interact";
import { listen, followHostTheme } from "../src/host";
import { setRefResolver, setCodeHighlighter } from "@yhnocoder/markdown";
import { langId, THEMES, EXPERIMENTAL_THEMES } from "@codeboard/core";
import { noteHighlight } from "../src/cm/load";
import { resolveCardRef } from "../src/actions";
import { storyChrome, type Globals } from "../stories/support/board";
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

// Storybook 的 viewport 工具会把 story 自己带的 viewport（UI/Toolbar 的 Narrow 那几个）写进用户的 globals：
// 从它们点到别的 story 还是 600px 宽。换到不带 viewport 的 story 时，换回进去之前用户自己选的那个。
// 用户的只在每个 story 第一次画时记：写进去的那一下会让上一个 story 带着窄的再画一遍
let userViewport: unknown;
let fromStory = false;
let lastId = "";
const viewport: Decorator = (Story, ctx) => {
  const [, update] = useGlobals();
  const c = ctx as typeof ctx & { storyGlobals: Record<string, unknown>; userGlobals: Record<string, unknown> };
  const first = c.id !== lastId;
  lastId = c.id;
  if ("viewport" in c.storyGlobals) fromStory = true;
  else if (first && fromStory) {
    fromStory = false;
    if (JSON.stringify(c.userGlobals.viewport) !== JSON.stringify(userViewport)) update({ viewport: userViewport ?? { value: undefined, isRotated: false } });
  } else if (first) userViewport = structuredClone(c.userGlobals.viewport);
  return Story();
};

// 挂不挂工具栏和 Dock：按 story 的标题和 parameters.chrome（support/board.tsx storyChrome）
const chrome: Decorator = (Story, ctx) => {
  storyChrome(ctx.title, ctx.parameters.chrome);
  return Story();
};

// 工具栏上悬停的开关（storybook-addon-pseudo-states）只管当前这个 story：换 story 时复位，不然下一个 story 的元素也都成了悬停。
// story 自己摆的悬停在它的 globals.pseudo 里，盖过这个
addons.getChannel().on(STORY_CHANGED, () => addons.getChannel().emit(UPDATE_GLOBALS, { globals: { pseudo: false } }));

const preview: Preview = {
  decorators: [chrome, scheme, viewport],
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
