import { render } from "solid-js/web";
import { App } from "./App";
import { onHost } from "./hostio";
import { installKeys } from "./interact";
import { listen, send, followHostTheme, forwardErrors } from "./host";
import { setRefResolver, setCodeHighlighter } from "@codeboard/markdown";
import { langId } from "@codeboard/core";
import { noteHighlight } from "./cm/load";
import { resolveCardRef } from "./actions";
import { flushSave } from "./state/store";
import "@codeboard/markdown/katex.css";
import "./fonts.css";
import "./styles.css";
// Markdown 的样式（Note、说明、批注、编辑器、代码编辑器）：接在 styles.css 后面、主题前面（themes.css 可以按主题改它）
import "@codeboard/markdown/style.css";
import "./themes.css";
import "./settings.css";

forwardErrors();
listen(onHost);
installKeys();
// 面板关掉、重载时：拖动中、镜头停下后还在等（LIVE_DELAY）没发的改动现在发出去
window.addEventListener("pagehide", () => flushSave());
setRefResolver(resolveCardRef, { missing: "No card with this title on the board" });
setCodeHighlighter(noteHighlight, langId);
followHostTheme();
render(() => <App />, document.getElementById("root")!);
send({ type: "ready" });
