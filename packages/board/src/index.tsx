import { render } from "solid-js/web";
import { App } from "./App";
import { onHost } from "./hostio";
import { installKeys } from "./interact";
import { flushSave } from "./state/store";
import { listen, send } from "./host";
import "katex/dist/katex.min.css";
import "./styles.css";

listen(onHost);
installKeys();
// 跟着 VS Code 的明暗主题：body 上的 vscode-light / vscode-dark / vscode-high-contrast
const syncTheme = () => {
  const c = document.body.classList;
  document.documentElement.dataset.theme = c.contains("vscode-light") || c.contains("vscode-high-contrast-light") ? "light" : "dark";
};
syncTheme();
new MutationObserver(syncTheme).observe(document.body, { attributes: true, attributeFilter: ["class"] });
window.addEventListener("beforeunload", flushSave);
document.addEventListener("visibilitychange", () => { if (document.hidden) flushSave(); });
render(() => <App />, document.getElementById("root")!);
send({ type: "ready" });
