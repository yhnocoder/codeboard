// Starts the board in a page of its own (#root): the VS Code webview (index.tsx), the harness's pages. The page's shell passes how
// the board reaches its host
import { render } from "solid-js/web";
import { setKeyPassThrough } from "@yhnocoder/markdown/ui";
import { App } from "./App";
import { wireBoard, type BoardOptions, type Transport } from "./wire";
import { reportFocus } from "./focus";
import { send, forwardErrors } from "./host";
import { vscodeKey } from "./ui/vscodekeys";
import "@yhnocoder/markdown/katex.css";
import "./fonts.css";
import "./styles.css";
// Markdown 的样式（Note、说明、批注、编辑器、代码编辑器）：接在 styles.css 后面、主题前面（themes.css 可以按主题改它）
import "@yhnocoder/markdown/style.css";
import "./themes.css";
import "./settings.css";

export type { BoardOptions, Transport };

export function boot(t: Transport, o: BoardOptions) {
  forwardErrors();
  wireBoard(t, o);
  reportFocus();
  setKeyPassThrough(vscodeKey); // 输入框里的剪贴板、撤销、命令面板之类交给 VS Code
  render(() => <App />, document.getElementById("root")!);
  send({ type: "ready" });
}
