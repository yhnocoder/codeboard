// 等 DeepSeek 的时候：卡上盖一层（一道光扫过、左上角「Reading image…  3.2 s  Cancel Esc」）；剪贴板的 Paste Image Text 没有卡，
// 同样的条子浮在工具栏上方；New SVG from Text… 也还没有卡，在视口中间（画好的图放的地方）摆一张空卡的样子盖着同样的一层。
// 只有 CSS 动画和每 100 ms 改一次的秒数，不重排卡片
import { For, createSignal, onCleanup } from "solid-js";
import { aiJobs, type AiJob } from "../state/imageai";
import { cam } from "../state/camera";

function Chip(p: { job: AiJob }) {
  const t0 = performance.now();
  const [s, setS] = createSignal(0);
  const iv = window.setInterval(() => setS((performance.now() - t0) / 1000), 100);
  onCleanup(() => clearInterval(iv));
  return (
    <div class="aichip" data-nodrag onPointerDown={(e) => e.stopPropagation()}>
      <i class="aispin" /><span>{p.job.label}</span><span class="ait">{s().toFixed(1)} s</span>
      <button class="aix" aria-label="Cancel" onClick={(e) => { e.stopPropagation(); p.job.cancel(); }}>Cancel <kbd>Esc</kbd></button>
    </div>
  );
}

export function AiBusy(p: { job: AiJob }) {
  return <div class="aibusy" data-export="strip"><div class="aishim" /><Chip job={p.job} /></div>;
}

/** 没有卡的：剪贴板的条子；ghost 的是视口中间一张随缩放大小的空卡（新卡的默认宽，SVG 常见的 3:2） */
export function AiClipBusy() {
  return (
    <For each={aiJobs().filter((j) => !j.card)}>{(j) => j.ghost
      ? <div class="aighost" style={{ width: `${Math.round(GHOST_W * cam.z)}px` }}><AiBusy job={j} /></div>
      : <div class="over aiclip"><Chip job={j} /></div>}</For>
  );
}
const GHOST_W = 360;
