import { Show } from "solid-js";
import { state } from "./store";
import { Canvas } from "./components/Canvas";
import { TopBar, DiffPopover, Toast, PresentBar } from "./components/Overlays";

export function App() {
  return (
    <div class="app">
      <Show when={state.loaded} fallback={<div class="loading">正在打开白板…</div>}>
        <Canvas />
        <TopBar />
        <PresentBar />
        <DiffPopover />
      </Show>
      <Toast />
    </div>
  );
}
