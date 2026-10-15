import { render } from "solid-js/web";
import { createRoot } from "solid-js";
import { App } from "./App";
import { installAutosave, onHost } from "./store";
import { installKeys } from "./components/Canvas";
import { listen, send } from "./host";
import "./styles.css";

createRoot(() => installAutosave());
listen(onHost);
installKeys();
render(() => <App />, document.getElementById("root")!);
send({ type: "ready" });
