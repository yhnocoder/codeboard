import { render } from "solid-js/web";
import { App } from "./App";
import { wireBoard } from "./wire";
import { reportFocus } from "./focus";
import { send, forwardErrors } from "./host";
import { setKeyPassThrough } from "@yhnocoder/markdown/ui";
import { vscodeKey } from "./ui/vscodekeys";
import "@yhnocoder/markdown/katex.css";
import "./fonts.css";
import "./styles.css";
// Markdown 的样式（Note、说明、批注、编辑器、代码编辑器）：接在 styles.css 后面、主题前面（themes.css 可以按主题改它）
import "@yhnocoder/markdown/style.css";
import "./themes.css";
import "./settings.css";

forwardErrors();
wireBoard();
reportFocus();
setKeyPassThrough(vscodeKey); // 输入框里的剪贴板、撤销、命令面板之类交给 VS Code
render(() => <App />, document.getElementById("root")!);
send({ type: "ready" });
