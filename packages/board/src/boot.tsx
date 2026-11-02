// Starts the board in a page of its own (#root): the VS Code webview (index.tsx), the harness's pages. The page's shell passes how
// the board reaches its host
import { render } from "solid-js/web";
import { App } from "./App";
import { wireBoard, type BoardOptions, type Transport } from "./wire";
import { reportFocus } from "./focus";
import { send, forwardErrors } from "./host";
import { MdContext } from "./md/context";
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
  const md = wireBoard(t, o);
  reportFocus();
  render(
    () => (
      <MdContext.Provider value={md}>
        <App />
      </MdContext.Provider>
    ),
    document.getElementById("root")!,
  );
  send({ type: "ready" });
}
