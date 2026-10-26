// 没有 VS Code 时 src/host.ts 把消息 push 进 window.__cbSent：先放一个改了 push 的数组，就能不改 host.ts 当宿主回 ask
import type { AskType, BoardToHost, SegView } from "@codeboard/core";
import code from "../fixtures/code.json";

export const VIEWS: Record<string, SegView> = Object.fromEntries(Object.values(code).map((x) => [x.seg.id, x.view as SegView]));

// 没有仓库、不存盘：回空的，白板照常走下去
const REPLIES: Partial<Record<AskType, (m: any) => unknown>> = {
  patch: () => ({ skipped: 0 }),
  views: (m: Extract<BoardToHost, { type: "views" }>) => Object.fromEntries(m.segs.filter((s) => VIEWS[s.id]).map((s) => [s.id, VIEWS[s.id]])),
  skeletons: () => ({}),
  permalinks: () => ({}),
  stickerPacks: () => [],
  questions: () => [],
  search: () => [],
  entryPoints: () => [],
  searchName: () => [],
  commits: () => [],
  callVars: () => [],
  lspComplete: () => [],
  lspHover: () => [],
  confirm: () => false,
};

const sent: unknown[] = [];
sent.push = (...ms: unknown[]) => {
  for (const m of ms) {
    const q = m as BoardToHost & { req?: number };
    if (typeof q.req === "number") {
      const data = REPLIES[q.type as AskType]?.(q) ?? null;
      window.postMessage({ type: "reply", req: q.req, data }, "*");
    }
  }
  return Array.prototype.push.apply(sent, ms);
};
window.__cbSent = sent;
