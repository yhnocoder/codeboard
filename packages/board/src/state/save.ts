// Saving: after each change the board sends the host what changed (a BoardPatch); the host puts it in at once and writes the file
// a little later. No Solid: the board, the post and the timers come in through `SaveDeps`.
// VS Code drops unhandled messages when a panel closes, so a change is sent when the task that made it ends (a microtask, one
// per task): by the time a change is on screen its message is out; sent on the next frame, closing the tab right after Esc ends
// an edit would lose it. Live changes during a drag and the camera coming to rest wait LIVE_DELAY (no whole-board snapshot every
// frame); closing the tab within LIVE_DELAY loses only the camera.
// The patch = the current snapshot against the one sent last, by id: changed items, deleted ids, changed board fields, the camera.
import type { Board, BoardPatch } from "@codeboard/core";
import { camKey, diff, type Sent, type Snap } from "./snap";
import { NOT_UNDONE } from "./history";

export interface SaveDeps {
  /** Is there a board yet (nothing is sent before the host's first board) */
  loaded(): boolean;
  /** The current board as a snapshot, and its camera */
  snap(): Snap;
  cam(): Board["cam"];
  /** Read and clear "undo / redo since the last save" */
  takeUndone(): boolean;
  /** Send the patch; resolves with the host's answer (skipped = shared items it did not undo) */
  post(patch: BoardPatch, undo: boolean): Promise<{ skipped: number }>;
  toast(text: string): void;
  liveDelay: number;
  resendDelay: number;
}

export function createSave(d: SaveDeps) {
  /** What was sent last; null = not known what the host has (it did not take the last one): the next send is the whole board */
  let sent: Sent | null = null;
  let queued = false;
  let liveTimer: ReturnType<typeof setTimeout> | undefined;
  let resend: ReturnType<typeof setTimeout> | undefined;

  function changed() {
    if (queued) return;
    queued = true;
    queueMicrotask(() => {
      queued = false;
      flush();
    });
  }
  function changedLive() {
    if (!d.loaded()) return;
    clearTimeout(liveTimer);
    liveTimer = setTimeout(() => flush(), d.liveDelay);
  }
  function flush(retry = false) {
    clearTimeout(resend);
    clearTimeout(liveTimer);
    if (!d.loaded()) return;
    const s = d.snap();
    const cam = d.cam();
    const p = diff(sent, s, cam);
    if (!p) return;
    sent = { snap: s, cam: camKey(cam) };
    d.post(p, d.takeUndone()).then(
      (r) => {
        if (r?.skipped) d.toast(NOT_UNDONE);
      },
      (e: Error) => {
        sent = null;
        if (retry) return;
        d.toast(`Couldn't save the board: ${e.message}`);
        resend = setTimeout(() => flush(true), d.resendDelay); // sent whole once more; not taken again → wait for the next change
      },
    );
  }
  /** The host already has the board as it is now (it just sent it, or just merged it in) */
  function align() {
    sent = { snap: d.snap(), cam: camKey(d.cam()) };
  }

  return {
    changed,
    changedLive,
    flush,
    /** The board the host just sent is the saved one */
    markSaved() {
      align();
      d.takeUndone();
    },
    /** The host changed the board itself (shared cards, a merge): what it has is now, so this is not sent back */
    alignSent() {
      if (sent) align();
    },
  };
}
