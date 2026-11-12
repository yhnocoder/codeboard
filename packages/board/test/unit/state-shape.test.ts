// Rules on the board's state and gestures, checked by shape:
// - the board is written only in state/changes.ts, segment views and version states (`state.views`, `state.stale`) only in
//   state/views.ts: those two are the only ones to import the store's setState, by name or through a namespace import
// - module-level mutable state (see moduleState) is the current board's and declared with state/root.ts's board* helpers, which
//   reset it on a board switch, unless it is listed below as outliving a board
// - drags go through gesture.ts: no other file listens on the window or the document for pointer moves (but the listed trackers,
//   which never listen for a release there), a release is waited for there only while holding the gesture, and an undo step for a
//   gesture (beginGesture) is always held with holdGesture, so a board switch drops it
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { parseAst } from "vite";
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

// Module-level state, found on the syntax tree (vite's parser: the board's typescript is the native compiler, which has no
// in-process parser). State is every top-level let, and every top-level const holding something that changes: a signal or store
// made without the board* helpers, an instance of a class, an empty Map / Set / WeakMap / WeakSet, and an array, object or filled
// Map / Set that some file writes (a table built from constants is not state). The body of a function the entries run once at
// boot (wire.ts's wireBoard, boot.tsx's boot) lives as long as the page too, so its state counts, keyed `file:function.name`
type Node = { type: string; name?: string; [k: string]: unknown };
const isNode = (v: unknown): v is Node => !!v && typeof v === "object" && typeof (v as Node).type === "string";
const get = (n: Node | undefined, k: string): Node | undefined => (n && isNode(n[k]) ? n[k] : undefined);
const list = (n: Node | undefined, k: string): Node[] =>
  n && Array.isArray(n[k]) ? (n[k] as unknown[]).filter(isNode) : [];
const each = (n: Node, fn: (n: Node) => void) => {
  fn(n);
  for (const v of Object.values(n)) for (const k of Array.isArray(v) ? v : [v]) if (isNode(k)) each(k, fn);
};
const WRAPPERS = new Set([
  "TSAsExpression",
  "TSSatisfiesExpression",
  "TSNonNullExpression",
  "TSTypeAssertion",
  "ParenthesizedExpression",
]);
const unwrap = (n: Node | undefined) => {
  while (n && WRAPPERS.has(n.type)) n = get(n, "expression");
  return n;
};
const bound = (p: Node | undefined): string[] =>
  !p
    ? []
    : p.type === "Identifier"
      ? [p.name!]
      : p.type === "ArrayPattern"
        ? list(p, "elements").flatMap(bound)
        : p.type === "ObjectPattern"
          ? list(p, "properties").flatMap((q) => bound(get(q, q.type === "RestElement" ? "argument" : "value")))
          : p.type === "AssignmentPattern"
            ? bound(get(p, "left"))
            : p.type === "RestElement"
              ? bound(get(p, "argument"))
              : [];
/** the variable at the root of `a`, `a.b[c]`, `(a as T).b` */
const root = (n: Node | undefined): string | undefined => {
  n = unwrap(n);
  while (n?.type === "MemberExpression") n = unwrap(get(n, "object"));
  return n?.type === "Identifier" ? n.name : undefined;
};
const MUTATORS = new Set([
  "push",
  "pop",
  "shift",
  "unshift",
  "splice",
  "sort",
  "reverse",
  "fill",
  "copyWithin",
  "set",
  "add",
  "delete",
  "clear",
]);
const COLLECTIONS = new Set(["Map", "Set", "WeakMap", "WeakSet"]);
/** the variables a file writes into: a field assigned or deleted, a mutating method called, Object.assign's target */
const writtenIn = (ast: Node) => {
  const out = new Set<string>();
  const add = (x: string | undefined) => x && out.add(x);
  each(ast, (n) => {
    const target =
      n.type === "AssignmentExpression"
        ? get(n, "left")
        : n.type === "UpdateExpression" || (n.type === "UnaryExpression" && n.operator === "delete")
          ? get(n, "argument")
          : undefined;
    if (unwrap(target)?.type === "MemberExpression") add(root(target));
    if (n.type !== "CallExpression") return;
    const callee = unwrap(get(n, "callee"));
    if (callee?.type !== "MemberExpression" || callee.computed) return;
    const method = get(callee, "property")?.name ?? "";
    if (MUTATORS.has(method)) add(root(get(callee, "object")));
    if (method === "assign" && get(callee, "object")?.name === "Object") add(root(list(n, "arguments")[0]));
  });
  return out;
};
// made without the board* helpers, these never reset
const SOLID_STATE = new Set(["createSignal", "createStore", "createMutable", "createMeasure", "createGhostHold"]);
const BOOT = ["wire.ts", "boot.tsx"];
/** each piece of module-level state, as `file:name` (`file:function.name` inside a function run once at boot) */
function moduleState(files?: Record<string, string>) {
  const texts = files ?? Object.fromEntries(walk(SRC).map((f) => [rel(f), fs.readFileSync(f, "utf8")]));
  const asts = Object.entries(texts).map(
    ([f, t]) => [f, parseAst(t, { lang: f.endsWith("x") ? "tsx" : "ts" }) as unknown as Node] as const,
  );
  // what any file writes, by its own name and, when imported, by the name it is exported under
  const written = new Set<string>();
  for (const [, ast] of asts) {
    const w = writtenIn(ast);
    for (const x of w) written.add(x);
    for (const imp of list(ast, "body").filter((s) => s.type === "ImportDeclaration"))
      for (const s of list(imp, "specifiers"))
        if (s.type === "ImportSpecifier" && w.has(get(s, "local")?.name ?? "")) written.add(get(s, "imported")!.name!);
  }
  const unexport = (s: Node) => (s.type === "ExportNamedDeclaration" && get(s, "declaration")) || s;
  const fns = new Map<string, [string, Node]>();
  for (const [f, ast] of asts)
    for (const s of list(ast, "body").map(unexport))
      if (s.type === "FunctionDeclaration") fns.set(get(s, "id")!.name!, [f, s]);
  // the functions the boot entries call in their own bodies (or in a rooted() callback, which runs at once)
  const once = new Set<string>();
  const calls = (n: Node) => {
    if (n.type === "CallExpression") {
      const c = get(n, "callee");
      if (c?.type === "Identifier") once.add(c.name!);
      if (c?.name === "rooted") for (const a of list(n, "arguments")) calls(get(a, "body") ?? a);
    }
    if (/Function/.test(n.type)) return;
    for (const v of Object.values(n)) for (const k of Array.isArray(v) ? v : [v]) if (isNode(k)) calls(k);
  };
  for (const f of BOOT) {
    const entry = fns.get(f === "wire.ts" ? "wireBoard" : "boot");
    if (entry?.[0] === f) for (const s of list(get(entry[1], "body"), "body")) calls(s);
  }
  // each scope's statements, with what goes before a name in its key
  const scopes: [string, Node[]][] = asts.map(([f, ast]) => [`${f}:`, list(ast, "body").map(unexport)]);
  for (const name of once) {
    const fn = fns.get(name);
    if (fn) scopes.push([`${fn[0]}:${name}.`, list(get(fn[1], "body"), "body")]);
  }
  return scopes.flatMap(([prefix, body]) =>
    body
      .filter((s) => s.type === "VariableDeclaration")
      .flatMap((s) =>
        list(s, "declarations").flatMap((d) => {
          const init = unwrap(get(d, "init"));
          const callee = init?.type === "CallExpression" ? get(init, "callee")?.name : undefined;
          const made = init?.type === "NewExpression" ? (get(init, "callee")?.name ?? "") : undefined;
          // a signal or store's getter stands for it: the setter is how it is written
          const names =
            callee && SOLID_STATE.has(callee) && get(d, "id")?.type === "ArrayPattern"
              ? bound(get(d, "id")).slice(0, 1)
              : bound(get(d, "id"));
          return names
            .filter(
              (x) =>
                s.kind !== "const" ||
                (!!callee && SOLID_STATE.has(callee)) ||
                (made !== undefined &&
                  (!COLLECTIONS.has(made) || list(init, "arguments").length === 0 || written.has(x))) ||
                ((init?.type === "ArrayExpression" || init?.type === "ObjectExpression") && written.has(x)),
            )
            .map((x) => prefix + x);
        }),
      ),
  );
}

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
  "state/root.ts:resets": "what a board switch runs",
  "state/still.ts:still": "whether the page draws a still picture: set once at boot",
  "state/store.ts:state": "the board itself and the host's info: replaced on init",
  "state/camera.ts:cam": "the camera: set from the new board on init",
  "state/camera.ts:anims": "the frame loop's animations (a sub-board switch animates across the switch)",
  "state/camera.ts:last": "the frame loop's clock",
  "state/camera.ts:still": "the camera's settle timer",
  "state/camera.ts:running": "the camera's flight",
  "state/camera.ts:viewport": "the window's size",
  "state/camera.ts:heldZ": "the camera's zoom held while it moves",
  "state/camera.ts:sx": "the camera's springs",
  "state/camera.ts:sy": "the camera's springs",
  "state/camera.ts:sz": "the camera's springs",
  "state/camera.ts:gen": "the camera's animation generation",
  "state/camera.ts:rafOn": "the frame loop's running flag",
  "state/camera.ts:resting": "waiting for the camera's flight to end: setCam on init ends it",
  "state/camera.ts:stillGen": "the camera's settle timer generation",
  "state/camera.ts:camMoving": "whether the camera moves",
  "state/camera.ts:viewSig": "the window's size",
  "state/ink.ts:dark": "VS Code's light or dark theme",
  "state/mode.ts:spaceDown": "the space key held: the keyboard's, released by its keyup after a switch",
  "state/changes.ts:ports": "the undo engine's ports: its self-check set once at boot",
  "state/changes.ts:canUndo": "the undo engine's stacks, which it reports again for the board it switches to",
  "state/changes.ts:canRedo": "the undo engine's stacks, which it reports again for the board it switches to",
  "state/changes.ts:stacksRev": "the undo engine's stacks, which it reports again for the board it switches to",
  "state/lead.ts:was":
    "the camera a frame ago, kept only while the lead view is asked for: a board switch is a pause or a jump, which the lead view does not follow",
  "state/lead.ts:armed": "the frame loop's snapshot of the camera",
  "state/lead.ts:quiet": "the frame loop's snapshot of the camera: frames since the last call",
  "state/measure.ts:measure": "the page's read-then-write measuring and its shared ResizeObserver",
  "gesture.ts:ghosts": "the page's hold on AI completions: a gesture's drop releases it",
  "state/measure.ts:lastPtr": "the pointer",
  "state/measure.ts:down": "the pointer's last press",
  "state/measure.ts:boardAt": "the board element's place in the window",
  "state/measure.ts:charW": "the code font's width",
  "state/hover.ts:ptr": "the pointer",
  "state/toast.ts:toastTimer": "the toast, which stays across a switch",
  "state/toast.ts:toastMsg": "the toast, which stays across a switch",
  "state/toast.ts:toastN": "an id counter",
  "state/blocks.ts:sheet": "the one style element for block tints",
  "state/blocks.ts:tinted": "what that style element holds",
  "state/tilt.ts:raf": "the tilt frame loop: stops by itself once no card turns",
  "md/lazy.ts:pending": "Markdown render jobs by element: ones no longer on the page are skipped",
  "md/lazy.ts:idleOn": "the render queue's idle loop",
  "md/lazy.ts:spent": "the render queue's frame budget",
  "md/lazy.ts:spentAt": "the render queue's frame budget: when it was last refilled",
  "md/lazy.ts:frameOn": "the render queue's frame loop",
  "md/lazy.ts:watching": "the render queue's camera watch",
  "md/images.ts:base": "the host's asset address: set on init",
  "md/images.ts:key": "the host's asset and copies addresses: set on init",
  "md/anim.ts:save": "how a Note image's playback is saved, wired once",
  "md/anim.ts:raf": "the animated images' frame loop: stops by itself once none plays",
  "md/anim.ts:seen": "the page's observer of animated images on screen",
  "md/anim.ts:sized": "the page's observer of animated images' sizes",
  "md/anim.ts:players": "a tick when players come and go",
  "md/copies.ts:rev": "a tick when the host's copies of images change",
  "md/math.ts:rev": "a tick when the math preamble changes",
  "cm/load.ts:ready": "the code editor module, once loaded",
  "md/load.ts:ready": "the editor module, once loaded",
  "host.ts:forwardErrors.seen": "errors forwarded lately: each once in 5 seconds",
  "stickers/glyphs.tsx:packs": "the sticker packs, loaded once",
  "md/refs.ts:xrefs": "the workspace's other boards' cards: the host keeps them current",
  "md/refs.ts:asked": "asked the host for those once",
  "hostio.ts:preloaded": "the editors preloaded once",
  "hostio.ts:held": "messages held while the old board fades out in a switch",
  "ui/shield.ts:el": "the pan shield element",
  "ui/shield.ts:fwd": "where the pan shield forwards to",
  "ui/shield.ts:at": "where the pan shield was put",
  "ui/shield.ts:dropT": "the pan shield's timer",
  "ui/shield.ts:up": "where the pan shield forwards a release to",
  "host.ts:transport": "the way to the host, given once at boot",
  "host.ts:req": "a request id counter",
  "ui/Menu.tsx:menuN": "an id counter",
  "state/pop.ts:n": "an id counter",
  "state/ui.ts:pingN": "an id counter",
  "actions/imageai.ts:jobN": "an id counter",
  "md/load.ts:seq": "an id counter",
  "canvas/Labels.tsx:NONE": "a shared empty value, never written",
  // caches and loaders keyed by content
  "md/blocks.ts:cache": "Markdown blocks by source text",
  "state/ink.ts:papers": "Ink Wash's card paper images, by edge pattern and light or dark",
  "state/inkframe.ts:frames": "Ink Wash's Section frames, by size, title width and Section",
  "md/load.ts:mod": "the editor module",
  "cm/load.ts:mod": "the code editor module",
  "stickers/glyphs.tsx:loading": "the sticker packs, loaded once",
  "stickers/glyphs.tsx:stillQueue": "still frames of animated stickers, by image",
  "stickers/glyphs.tsx:clean": "sticker icons' cleaned SVG, by icon",
  "stickers/glyphs.tsx:stills": "still frames of animated stickers, by image",
  "md/anim.ts:bytes": "animated images' bytes, by address (assets/ names carry their content's hash)",
  "md/anim.ts:svgMarkup": "animated SVGs cleaned for inline drawing, by address",
  "md/anim.ts:gifThumbs": "GIF filmstrip stills, by address",
  "actions/imageai.ts:colorCtx": "a canvas for parsing colors",
  "actions/flow.ts:sent": "calls prefetched lately, by segment: the host caches them",
  "md/copies.ts:known": "the host's smaller copies of images, by asset name (named by its content)",
  "md/copies.ts:made": "the copies asked of the host, by asset name and width: each made once",
  "md/copies.ts:wanted": "asset names to ask the host about in this task's batch: emptied by its microtask",
  // kept across boards on purpose
  "state/zoomlog.ts:rec":
    "the zoom diagnostics recording, which runs across board switches until the host command stops it",
  "actions/clipboard.ts:lastCopy": "the clipboard: its card is looked up on the board pasted on",
  "actions/shared.ts:copied": "the clipboard: carries the board it was copied on",
  "actions/shared.ts:cutClip": "the clipboard: carries the board it was cut on",
  "actions/imagedata.ts:lastPic": "the clipboard: a picture copied on one board pastes as that copy on the next",
  "actions/subboards.ts:transit": "the sub-board switch animation, which spans the switch",
  "actions/subboards.ts:titleAt": "where each board's frames showed their names, by board",
  "state/subboards.ts:crumbMorph": "the sub-board switch animation, which spans the switch",
  "state/stickers.ts:stickerColor": "the sticker picker's last colour, kept for the next sticker on any board",
  "state/export.ts:exportBusy": "an export under way, which sets it back when it ends (a switch fails its asks)",
  "state/export.ts:exportHidden": "an export under way, which sets it back when it ends",
  "state/questions.ts:questionsOpen":
    "the questions panel: it lists every board's questions and stays open when one of them opens another board",
  "state/questions.ts:qTab": "the questions panel's tab",
  // set from each board's init
  "state/questions.ts:welcome": "the open questions the host counts for this board",
  "state/subboards.ts:crumbs": "the breadcrumbs",
  // panels, menus and dialogs: layers of the overlay stack, which closes them on a switch (ui/overlay.ts closeOverlays)
  "ui/overlay.ts:stack": "the overlay stack: all but the layers that stay are closed on a switch",
  "ui/Menu.tsx:menu": "the context menu",
  "ui/Menu.tsx:dialog": "the dialog",
  "state/ui.ts:paletteOpen": "the ⌘K palette",
  "state/ui.ts:keysOpen": "the keys panel",
  "state/export.ts:exportOpen": "the export dialog",
  "state/web.ts:ghPicker": "the From GitHub… panel",
  "state/stickers.ts:stickerPick": "the sticker picker",
  "state/ui.ts:settingsOpen": "the settings page: a layer that stays, about no board in particular",
  "actions/variants.ts:asked":
    "each merge into upstream asked about once in this window (the host resends them on every init)",
  // reset on a board switch by their own onBoardSwitch, which does more than emptying them or empties arrays changed in place
  "actions/nav.ts:back": "the jump history: emptied by resetNav",
  "actions/nav.ts:fwd": "the jump history: emptied by resetNav",
  "host.ts:pending": "requests: each one fails on a switch",
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
  "state/ui.ts:codeTextRange": "set by each mounted code view, by its element (weakly held)",
  "md/anim.ts:watchers": "players by the element they watch: each leaves when dropped",
  "ui/Menu.tsx:levels": "the open menu's levels: each leaves when it unmounts",
  "md/anim.ts:byView":
    "animated image players, by the mounted Note view drawing them (dropped when it repaints or unmounts)",
  "md/anim.ts:running": "the players playing now: each leaves when it stops or is dropped",
  "canvas/routes.ts:drawn": "the drawn links (trackLinks)",
  "canvas/routes.ts:modes": "each drawn link's last side choice",
  "canvas/routes.ts:landN": "how many drawn links land on a card's side",
  "canvas/routes.ts:landSig": "a signal per card side, read by its port",
  "canvas/routes.ts:sliding": "each drawn link's side slide in progress",
  "canvas/routes.ts:slideOn": "the side-slide frame loop: stops by itself once no link slides",
};

describe("board state per board", () => {
  const found = moduleState();

  it("declares module-level state with the board* helpers unless it outlives a board", () => {
    expect(found.filter((k) => !(k in OUTLIVES_BOARD)).sort()).toEqual([]);
  });

  it("lists only module-level state that still exists as outliving a board", () => {
    expect(Object.keys(OUTLIVES_BOARD).filter((k) => !found.includes(k))).toEqual([]);
  });

  it("finds the state a line-by-line match would miss", () => {
    const keys = moduleState({
      "a.ts": `
        let a = 0, b = 1;
        const stack: string[] = [], table = ["x"];
        const at = { x: 0 };
        const byEl = new WeakMap<object, number>(), names = new Map([["a", 1]]);
        const [sig, setSig] = createSignal(0);
        export const spring = new Spring(0);
        export function wireThings() {
          let held = false;
          const seen = new Set<string>();
          const out = () => { held = true; };
        }
        function later() { let local = 0; }
        stack.push("s");
        at.x = 1;
      `,
      "b.ts": `import { byEl as els } from "./a"; els.set({}, 1);`,
      "wire.ts": `export function wireBoard() { wireThings(); }`,
    });
    expect(keys.sort()).toEqual(
      [
        "a.ts:a",
        "a.ts:b",
        "a.ts:stack",
        "a.ts:at",
        "a.ts:byEl",
        "a.ts:sig",
        "a.ts:spring",
        "a.ts:wireThings.held",
        "a.ts:wireThings.seen",
      ].sort(),
    );
  });
});

describe("board wiring", () => {
  // what the board does is wired by the entries (index.tsx through boot() and wire.ts's wireBoard, the stories), not by importing
  // a module: the only top-level calls elsewhere reset a module's own state on a board switch (onBoardSwitch) or make the shared
  // root (state/root.ts)
  const ENTRIES = ["index.tsx", "export/viewer.ts"];
  it("starts nothing by importing a module", () => {
    expect(
      lines(/^(?!onBoardSwitch\()[A-Za-z_$][\w$.]*\(/, ENTRIES).filter((l) => !l.startsWith("state/root.ts:")),
    ).toEqual([]);
  });
});

describe("board gestures", () => {
  // a drag listens for the moves on the window (or the document): only track() in gesture.ts does that. Besides it, these follow
  // the pointer with no button held, and none of them listens for a release there
  const TRACKERS = new Set([
    "state/hover.ts", // which card or link the pointer is over
    "state/measure.ts", // the last pointer position
    "state/blocks.ts", // the Note block under the pointer
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

  it("wait for a release on the window only while holding the gesture, so a board switch drops it", () => {
    const loose = walk(SRC)
      .filter((f) => !["gesture.ts", SHIELD].includes(rel(f)))
      .filter((f) => {
        const t = fs.readFileSync(f, "utf8");
        return listens(t, "up|cancel|end") && !/\bholdGesture\(/.test(t);
      })
      .map(rel);
    expect(loose).toEqual([]);
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
