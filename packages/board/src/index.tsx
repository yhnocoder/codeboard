import { render } from "solid-js/web";
import { App } from "./App";
import { onHost } from "./hostio";
import { installKeys } from "./interact";
import { listen, send, followHostTheme, forwardErrors } from "./host";
import { setRefResolver } from "./md/view";
import { resolveCardRef } from "./actions";
import { flushSave } from "./state/store";
import "katex/dist/katex.min.css";
import "./fonts.css";
import "./styles.css";
import "./themes.css";
import "./settings.css";

forwardErrors();
listen(onHost);
installKeys();
// 面板关掉、重载时：拖动中、镜头停下后还在等（LIVE_DELAY）没发的改动现在发出去
window.addEventListener("pagehide", flushSave);
setRefResolver(resolveCardRef);
followHostTheme();
render(() => <App />, document.getElementById("root")!);
send({ type: "ready" });
