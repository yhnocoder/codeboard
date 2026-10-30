import { render } from "solid-js/web";
import { App } from "./App";
import { onHost } from "./hostio";
import { installKeys } from "./interact";
import { reportFocus } from "./focus";
import { listen, send, followHostTheme, forwardErrors } from "./host";
import { setRefResolver, setCodeHighlighter } from "@yhnocoder/markdown";
import { setKeyPassThrough } from "@yhnocoder/markdown/ui";
import { vscodeKey } from "./ui/vscodekeys";
import { langId } from "@codeboard/analysis/langs";
import { noteHighlight } from "./cm/load";
import { resolveCardRef } from "./actions";
import "@yhnocoder/markdown/katex.css";
import "./fonts.css";
import "./styles.css";
// Markdown 的样式（Note、说明、批注、编辑器、代码编辑器）：接在 styles.css 后面、主题前面（themes.css 可以按主题改它）
import "@yhnocoder/markdown/style.css";
import "./themes.css";
import "./settings.css";

forwardErrors();
listen(onHost);
installKeys();
reportFocus();
setKeyPassThrough(vscodeKey); // 输入框里的剪贴板、撤销、命令面板之类交给 VS Code
setRefResolver(resolveCardRef, { missing: "Nothing with this title on the board" });
setCodeHighlighter(noteHighlight, langId);
followHostTheme();
render(() => <App />, document.getElementById("root")!);
send({ type: "ready" });
