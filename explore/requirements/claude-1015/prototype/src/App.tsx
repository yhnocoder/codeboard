import { Show, onMount } from "solid-js";
import { state } from "./store";
import { Canvas, installKeys } from "./components/Canvas";
import { TopBar, Sidebar, SourcePanel } from "./components/Panels";
import { Palette, DiffPopover, Menu, Toast, PresentBar } from "./components/Overlays";

export default function App() {
  onMount(installKeys);
  return (
    <div class="app" data-layout={state.layout}>
      <TopBar />
      <div class="main">
        <Show when={state.layout === "studio"}><Sidebar /></Show>
        <Canvas />
        <Show when={state.source}><SourcePanel /></Show>
      </div>
      <PresentBar />
      <Palette />
      <DiffPopover />
      <Menu />
      <Toast />
    </div>
  );
}
