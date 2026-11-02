// The board's actions are UI glue; the rules another shell would need too live in core's command layer. Checked by shape: the
// board never imports core's structural edits (every function in core/src/edit/ that takes a board to change, and the variant and
// sub-board ones), only the commands in @codeboard/core/commands that use them; and it calls mutate() itself only for the plain
// field changes listed in PLAIN, every other user edit is a command
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SRC = fileURLToPath(new URL("../../src", import.meta.url));
const CORE = fileURLToPath(new URL("../../../core/src", import.meta.url));
const walk = (d: string): string[] =>
  fs
    .readdirSync(d, { withFileTypes: true })
    .flatMap((e) =>
      e.isDirectory() ? walk(path.join(d, e.name)) : /\.tsx?$/.test(e.name) ? [path.join(d, e.name)] : [],
    );
const rel = (f: string) => path.relative(SRC, f).split(path.sep).join("/");

/** Functions in these files whose first parameter is the board they change */
const boardOps = (files: string[]) =>
  files.flatMap((f) =>
    [...fs.readFileSync(f, "utf8").matchAll(/export function (\w+)\(\s*\w+: Board\b/g)].map((m) => m[1]),
  );
const EDIT = path.join(CORE, "edit");
const GUARDED = new Set([
  ...boardOps(
    fs
      .readdirSync(EDIT)
      .filter((f) => f !== "check.ts") // danglingRefs only reads
      .map((f) => path.join(EDIT, f)),
  ),
  // the variant and sub-board ones (those files also hold readers)
  "addVariant",
  "switchVariant",
  "setVariantSegs",
  "rebaseUpstream",
  "removeVariant",
  "dropVariants",
  "extractBoard",
]);
/** [file, op, why]: the board's own wiring that applies what the host already decided, not a user's command */
const ALLOW: [string, string, string][] = [
  ["state/changes.ts", "removeCards", "syncGone: another board's Delete Everywhere, already done by the host"],
];

/**
 * [file, top-level function, how many mutate() calls, what they change]: the board's own mutate() calls. Each sets or toggles
 * plain fields of the objects it names, with nothing decided from the rest of the board (no item goes or moves elsewhere, no
 * default derived from content, nothing asked first). Anything more is a command in core/src/commands
 */
const PLAIN: [string, string, number, string][] = [
  ["actions/env.ts", "commandEnv", 1, "the command env's edit: what every command's env.edit runs"],
  ["Chrome.tsx", "Toolbar", 1, "Rename Board: the board's name"],
  ["hostio.ts", "handle", 1, "the board renamed in the editor: its name"],
  [
    "actions/autofocus.ts",
    "autoFocus",
    1,
    "a Note's Markdown, as the model marked it up (checked unchanged otherwise)",
  ],
  ["actions/format.ts", "formatStaticSel", 1, "a Note's Markdown with a mark toggled on the selected text"],
  ["actions/notes.ts", "setCaption", 1, "a Note's Markdown with an image caption set"],
  ["actions/notes.ts", "setMarkColor", 1, "a Mark's colour"],
  ["actions/notes.ts", "setBoxFill", 1, "a Box's fill"],
  ["actions/notes.ts", "updateSidenote", 1, "one sidenote's fields: its text, Always Show, Board-only, reviewed"],
  ["actions/calls.ts", "clearRpc", 1, "an arrow's RPC mark off"],
  ["actions/links.ts", "setLinkLabel", 1, "an arrow's label text"],
  ["actions/links.ts", "editLink", 1, "an arrow's fields: Call mark off, loop mark, label position, label"],
  ["actions/edit.ts", "setDesc", 1, "a card's description"],
  ["actions/edit.ts", "toggleHide", 1, "what a code card hides: comments, docstrings, blank lines"],
  ["actions/edit.ts", "toggleWrap", 1, "line wrap of the selected code cards"],
  ["actions/edit.ts", "toggleCollapse", 1, "a card folded"],
  ["actions/edit.ts", "toggleLock", 1, "the lock of the selected cards and Sections"],
  ["actions/edit.ts", "toggleTilt", 1, "the tilt of the selected cards"],
  ["actions/edit.ts", "keepLost", 1, "Keep Old Version on a card whose symbol is gone"],
  ["actions/edit.ts", "renameSection", 1, "a Section's title"],
  ["actions/menus.ts", "cardItems", 3, "a Compare's Swap, Unified, Hide Same Lines"],
  ["cards/CompareBody.tsx", "CompareBody", 1, "the same Compare switches, from its own toolbar"],
  ["actions/menus.ts", "sectionMenu", 1, "a Section's colour, or its parent one level up"],
  ["actions/flow.ts", "showAllMembers", 1, "a class card's member list shown in full"],
  ["actions/stickers.ts", "detachSticker", 1, "a sticker's place: on the canvas where it is drawn"],
  ["actions/stickers.ts", "stickerMenu", 1, "a canvas sticker's size"],
  ["actions/web.ts", "setList", 1, "a Link List's rich / compact default"],
  ["actions/web.ts", "setWebStyle", 1, "a Web card's compact / rich look"],
];

describe("command layer", () => {
  it("finds the structural edits it guards", () => {
    for (const op of [
      "removeCards",
      "rebaseSegment",
      "placeCards",
      "mergeCodeCards",
      "makeCompare",
      "cardIntoSidenote",
    ])
      expect(GUARDED.has(op), op).toBe(true);
  });

  it("the board reaches core's structural edits only through @codeboard/core/commands", () => {
    const hits: string[] = [];
    for (const f of walk(SRC)) {
      const t = fs.readFileSync(f, "utf8");
      for (const m of t.matchAll(/import\s*\{([^}]*)\}\s*from\s*["']@codeboard\/core["']/g))
        for (const name of m[1].split(",").map((x) => x.trim().split(/\s+as\s+/)[0]))
          if (GUARDED.has(name) && !ALLOW.some(([file, op]) => file === rel(f) && op === name))
            hits.push(`${rel(f)}: ${name}`);
      if (/import\s*\*\s*as\s+\w+\s*from\s*["']@codeboard\/core["']/.test(t))
        hits.push(`${rel(f)}: import * from core`);
    }
    expect(hits).toEqual([]);
  });

  it("the board calls mutate() itself only for the plain field changes in PLAIN", () => {
    const seen = new Map<string, number>();
    for (const f of walk(SRC)) {
      const t = fs.readFileSync(f, "utf8");
      for (const m of t.matchAll(/\bmutate\(/g)) {
        // the top-level function or const it is in
        const defs = [
          ...t
            .slice(0, m.index)
            .matchAll(/^(?:export\s+)?(?:default\s+)?(?:async\s+)?(?:function\s+(\w+)|const\s+(\w+))/gm),
        ];
        const d = defs.at(-1);
        const k = `${rel(f)} ${d ? (d[1] ?? d[2]) : "(top level)"}`;
        seen.set(k, (seen.get(k) ?? 0) + 1);
      }
    }
    const want = new Map(PLAIN.map(([f, fn, n]) => [`${f} ${fn}`, n]));
    expect(Object.fromEntries(seen)).toEqual(Object.fromEntries(want));
  });
});
