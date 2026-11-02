// Rules on the board's state and gestures, checked by shape:
// - the board is written only in state/changes.ts, segment views and version states (`state.views`, `state.stale`) only in
//   state/views.ts: those two are the only ones to import the store's setState, by name or through a namespace import
// - module-level mutable state (a store, an empty Map or Set, a let) is the current board's and declared with state/root.ts's
//   board* helpers, which reset it on a board switch, unless it is listed below as outliving a board
// - drags go through gesture.ts: no other file listens on the window or the document for pointer moves (but the listed trackers,
//   which never listen for a release there), and an undo step for a gesture (beginGesture) is always held with holdGesture, so a
//   board switch drops it
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SRC = fileURLToPath(new URL("../../src", import.meta.url));
const walk = (d: string): string[] =>
  fs
    .readdirSync(d, { withFileTypes: true })
    .flatMap((e) =>
      e.isDirectory() ? walk(path.join(d, e.name)) : /\.tsx?$/.test(e.name) ? [path.join(d, e.name)] : [],
    );
const rel = (f: string) => path.relative(SRC, f).split(path.sep).join("/");
/** file:line of the lines matching `re`, in the board's sources except `skip` */
const lines = (re: RegExp, skip: string[] = []) =>
  walk(SRC)
    .filter((f) => !skip.includes(rel(f)))
    .flatMap((f) =>
      fs
        .readFileSync(f, "utf8")
        .split("\n")
        .flatMap((l, i) => (re.test(l) ? [`${rel(f)}:${i + 1}`] : [])),
    );

describe("board state", () => {
  it("writes views and version states only in state/views.ts", () => {
    expect(lines(/setState\(\s*["'](views|stale)["']/, ["state/views.ts"])).toEqual([]);
  });

  it("writes the board only in state/changes.ts", () => {
    expect(lines(/setState\(\s*["']board["']/, ["state/changes.ts"])).toEqual([]);
  });

  it("lets only state/changes.ts and state/views.ts import the store's setState", () => {
    const STORE = String.raw`from\s*["'](?:\.\.?\/)+(?:state\/)?store["']`;
    const named = new RegExp(String.raw`import\s*\{[^}]*\bsetState\b[^}]*\}\s*${STORE}`);
    const spaces = new RegExp(String.raw`import\s*(?:type\s+)?(?:\w+\s*,\s*)?\*\s*as\s+(\w+)\s*${STORE}`, "g");
    const importers = walk(SRC)
      .filter((f) => {
        const t = fs.readFileSync(f, "utf8");
        // import * as S from "./store", then S.setState
        const viaSpace = [...t.matchAll(spaces)].some((m) =>
          new RegExp(String.raw`\b${m[1]}\s*\.\s*setState\b`).test(t),
        );
        return named.test(t) || viaSpace;
      })
      .map(rel)
      .sort();
    expect(importers).toEqual(["state/changes.ts", "state/views.ts"]);
  });
});

// Module-level state that is not the current board's, or that resets itself on a board switch some other way: file:name → why
const OUTLIVES_BOARD: Record<string, string> = {
  // the page's
  "state/root.ts:owner": "the shared root of module-level memos",
  "state/store.ts:state": "the board itself and the host's info: replaced on init",
  "state/camera.ts:cam": "the camera: set from the new board on init",
  "state/camera.ts:anims": "the frame loop's animations (a sub-board switch animates across the switch)",
  "state/camera.ts:last": "the frame loop's clock",
  "state/camera.ts:still": "the camera's settle timer",
  "state/camera.ts:running": "the camera's flight",
  "state/camera.ts:viewport": "the window's size",
  "state/camera.ts:heldZ": "the camera's zoom held while it moves",
  "state/lodcards.ts:held": "the map level's zoom held while the camera moves",
  "state/measure.ts:lastPtr": "the pointer",
  "state/measure.ts:down": "the pointer's last press",
  "state/measure.ts:boardAt": "the board element's place in the window",
  "state/measure.ts:charW": "the code font's width",
  "state/hover.ts:ptr": "the pointer",
  "state/idle.ts:on": "the idle-time queue",
  "state/toast.ts:toastTimer": "the toast, which stays across a switch",
  "state/blocks.ts:sheet": "the one style element for block tints",
  "state/blocks.ts:tinted": "what that style element holds",
  "state/tilt.ts:raf": "the tilt frame loop: stops by itself once no card turns",
  "md/lazy.ts:pending": "Markdown render jobs by element: ones no longer on the page are skipped",
  "md/lazy.ts:idleOn": "the render queue's idle loop",
  "md/lazy.ts:spent": "the render queue's frame budget",
  "md/lazy.ts:watching": "the render queue's camera watch",
  "md/images.ts:base": "the host's asset address: set on init",
  "md/refs.ts:xrefs": "the workspace's other boards' cards: the host keeps them current",
  "md/refs.ts:asked": "asked the host for those once",
  "hostio.ts:preloaded": "the editors preloaded once",
  "hostio.ts:held": "messages held while the old board fades out in a switch",
  "ui/shield.ts:el": "the pan shield element",
  "ui/shield.ts:fwd": "where the pan shield forwards to",
  "ui/Menu.tsx:menuN": "an id counter",
  "state/pop.ts:n": "an id counter",
  "state/ui.ts:pingN": "an id counter",
  "actions/imageai.ts:jobN": "an id counter",
  "md/load.ts:seq": "an id counter",
  "canvas/Labels.tsx:NONE": "a shared empty value, never written",
  // caches and loaders keyed by content
  "md/blocks.ts:cache": "Markdown blocks by source text",
  "md/load.ts:mod": "the editor module",
  "cm/load.ts:mod": "the code editor module",
  "stickers/glyphs.tsx:loading": "the sticker packs, loaded once",
  "stickers/glyphs.tsx:stillQueue": "still frames of animated stickers, by image",
  "actions/imageai.ts:colorCtx": "a canvas for parsing colors",
  "actions/flow.ts:sent": "calls prefetched lately, by segment: the host caches them",
  // kept across boards on purpose
  "actions/clipboard.ts:lastCopy": "the clipboard: its card is looked up on the board pasted on",
  "actions/shared.ts:copied": "the clipboard: carries the board it was copied on",
  "actions/shared.ts:cutClip": "the clipboard: carries the board it was cut on",
  "actions/subboards.ts:transit": "the sub-board switch animation, which spans the switch",
  "actions/subboards.ts:titleAt": "where each board's frames showed their names, by board",
  "actions/variants.ts:asked":
    "each merge into upstream asked about once in this window (the host resends them on every init)",
  // reset on a board switch by their own onBoardSwitch, which does more than emptying them
  "host.ts:pending": "requests: each one fails on a switch",
  "host.ts:req": "a request id counter",
  "gesture.ts:open": "gestures: each one is dropped on a switch",
  "actions/imageai.ts:live": "image jobs: each one is cancelled on a switch",
  "actions/variants.ts:shownView": "rebuilt from the new board on a switch",
  "state/sections.ts:easing": "emptied on a switch by stopEasing, which also puts the drawn frames back",
  "keymap.ts:held": "the arrow-key nudge: a gesture, dropped on a switch",
  // entries owned by mounted components, each removed when its component is cleaned up
  "state/extent.ts:extras": "registered by the label and alternatives components",
  "state/sections.ts:labelEls": "registered by the Section labels",
  "state/sections.ts:shown": "a signal per Section, read by its frame (stopEasing resets the values)",
  "state/fold.ts:folds": "a signal per Section, read by its frame (set back to undefined on a switch)",
  "md/load.ts:current": "the mounted Note editor",
  "canvas/routes.ts:drawn": "the drawn links (trackLinks)",
  "canvas/routes.ts:modes": "each drawn link's last side choice",
  "canvas/routes.ts:landN": "how many drawn links land on a card's side",
  "canvas/routes.ts:landSig": "a signal per card side, read by its port",
  "canvas/routes.ts:sliding": "each drawn link's side slide in progress",
  "canvas/routes.ts:slideOn": "the side-slide frame loop: stops by itself once no link slides",
};

describe("board state per board", () => {
  // a store, an empty Map / Set (a table built from constants is not state) or a let at the top of a module
  const DECL =
    /^(?:export\s+)?(?:let\s+(\w+)|const\s+(?:\[\s*(\w+)[^\]]*\]|(\w+))\s*(?::[^=]+)?=\s*(?:createStore\b|new\s+(?:Map|Set)\b(?:<.*>)?\(\)))/;
  const found = walk(SRC).flatMap((f) =>
    fs
      .readFileSync(f, "utf8")
      .split("\n")
      .flatMap((l) => {
        const m = DECL.exec(l);
        return m ? [`${rel(f)}:${m[1] ?? m[2] ?? m[3]}`] : [];
      }),
  );

  it("declares module-level stores, Maps, Sets and lets with the board* helpers unless they outlive a board", () => {
    expect(found.filter((k) => !(k in OUTLIVES_BOARD)).sort()).toEqual([]);
  });

  it("lists only module-level state that still exists as outliving a board", () => {
    expect(Object.keys(OUTLIVES_BOARD).filter((k) => !found.includes(k))).toEqual([]);
  });
});

describe("board gestures", () => {
  // a drag listens for the moves on the window (or the document): only track() in gesture.ts does that. Besides it, these follow
  // the pointer with no button held, and none of them listens for a release there
  const TRACKERS = new Set([
    "state/hover.ts", // which card or link the pointer is over
    "state/measure.ts", // the last pointer position
    "state/blocks.ts", // the Note block under the pointer
    "stickers/Picker.tsx", // the sticker that follows the pointer until a click places it
  ]);
  const SHIELD = "ui/shield.ts"; // the pan shield: page-long passive listeners that take it away on any move or release, no drag
  const listens = (t: string, kinds: string) =>
    new RegExp(
      String.raw`\b(?:window|document|globalThis)\s*\.\s*(?:addEventListener\(\s*["'](?:pointer|mouse|touch)(?:${kinds})["']|on(?:pointer|mouse|touch)(?:${kinds})\s*=)`,
    ).test(t);
  it("are tracked only in gesture.ts", () => {
    const sources = walk(SRC).filter((f) => !["gesture.ts", SHIELD].includes(rel(f)));
    const moves = sources.filter((f) => listens(fs.readFileSync(f, "utf8"), "move")).map(rel);
    // a tracker that stopped listening comes off the list
    expect(moves.sort()).toEqual([...TRACKERS].sort());
    expect(moves.filter((f) => listens(fs.readFileSync(path.join(SRC, f), "utf8"), "up|cancel|end"))).toEqual([]);
  });

  it("hold their undo step with holdGesture, so a board switch drops it", () => {
    const loose = walk(SRC)
      .filter((f) => !["gesture.ts", "state/changes.ts"].includes(rel(f)))
      .filter((f) => {
        const t = fs.readFileSync(f, "utf8");
        return /\bbeginGesture\(/.test(t) && !/\bholdGesture\(/.test(t);
      })
      .map(rel);
    expect(loose).toEqual([]);
  });
});
