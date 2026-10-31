// 每打一个键记下编辑器里这一段的样子（字 + 格式），和 typing-sequence.json 逐键比。RECORD=1 时重新录
import * as fs from "node:fs";
import * as path from "node:path";
import { REPO, put } from "../harness";
import { emptyBoard, type Board, type NoteCard } from "@codeboard/core";
import type { Page } from "playwright-core";
import { test, open, check, idle } from "../fixtures";

const FIXTURE = path.join(REPO, "packages/board/test/typing-sequence.json");
const SEQS: Record<string, string> = {
  bold: "x **bold** y",
  italic: "x *italic* y",
  strike: "x ~~strike~~ y",
  highlight: "x ==hl== y",
  code: "x `code` y",
  math: "x $m$ y",
  boldItalic: "x ***bi*** y",
  subSup: "H~2~O x^2^ y",
  singleTilde: "x ~a b~ y",
  link: "x [t](https://a.b) y",
  undoBold: "x **b**{Control+z} *i* y",
  undoMath: "x $a${Control+z} and $b$ y",
  undoHighlight: "x ==a=={Control+z} ==b== y",
};

function board(n: number): Board {
  const b = emptyBoard("b1", "typeseq");
  for (let i = 0; i < n; i++)
    put(
      b,
      { id: `n${i}`, kind: "note", md: "", look: "note" } as NoteCard,
      60 + (i % 4) * 560,
      60 + Math.floor(i / 4) * 360,
      520,
    );
  b.cam = { x: 0, y: 0, z: 1 };
  return b;
}

/** 编辑器里第一段：字照原样，格式写成 <b>…</b> 之类（装饰的 span 不算） */
const snap = (pg: Page) =>
  pg.evaluate(() => {
    const TAG: Record<string, string> = {
      STRONG: "b",
      EM: "i",
      S: "s",
      DEL: "s",
      MARK: "hl",
      CODE: "code",
      SUB: "sub",
      SUP: "sup",
      A: "a",
    };
    const walk = (n: Node): string => {
      if (n.nodeType === 3) return n.textContent ?? "";
      const e = n as HTMLElement;
      // hidden source (markers away from the caret, a formula's TeX under its drawing) is not on screen
      if (e.classList.contains("md-ghost") || e.classList.contains("md-hide")) return "";
      if (e.matches("[data-type=inline-math]")) return `<math:${e.getAttribute("data-latex") ?? e.textContent}>`;
      const inner = [...e.childNodes].map(walk).join("");
      const t = e.classList.contains("md-src") ? "src" : TAG[e.tagName];
      return t ? `<${t}>${inner}</${t}>` : inner;
    };
    const p = document.querySelector(".md-pm p");
    return p ? walk(p) : "";
  });
/** The editor's paragraph once it has stopped changing: the same in two frames in a row (input rules and the Markdown
 *  source marks are applied in the key's own task, decorations that follow the caret may take a frame) */
async function settled(pg: Page) {
  let a = await snap(pg);
  for (let i = 0; i < 120; i++) {
    await pg.evaluate(() => new Promise<void>((r) => requestAnimationFrame(() => r())));
    const b = await snap(pg);
    if (b === a) return b;
    a = b;
  }
  throw new Error(`settled: the paragraph kept changing for 120 frames (last: ${a})`);
}

test("typingKeyByKey", async () => {
  const names = Object.keys(SEQS);
  const h = await open({ board: board(names.length), light: true, w: 2400, h: 1600 });
  const pg = h.page;
  const got: Record<string, string[]> = {};
  for (let i = 0; i < names.length; i++) {
    const id = `n${i}`;
    await h.post({ type: "reveal", card: id } as any);
    await idle(h); // the camera flies to the card
    await pg.locator(`.card[data-id="${id}"] .nbody`).dblclick();
    await pg.locator(`.card[data-id="${id}"] .md-pm:focus`).waitFor();
    const states: string[] = [];
    for (const part of SEQS[names[i]].split(/(\{[^}]+\})/)) {
      if (!part) continue;
      for (const k of part.startsWith("{") ? [part] : [...part]) {
        if (k.startsWith("{")) await pg.keyboard.press(k.slice(1, -1));
        else await pg.keyboard.type(k);
        states.push(`${k} → ${await settled(pg)}`);
      }
    }
    got[names[i]] = states;
    for (let k = 0; k < 3 && (await pg.locator(".md-pm").count()); k++) {
      await pg.keyboard.press("Escape");
      await idle(h);
    }
  }
  await pg.context().close();
  if (process.env.RECORD) {
    fs.writeFileSync(FIXTURE, JSON.stringify(got, null, 2) + "\n");
    console.log(`recorded ${FIXTURE}`);
    return;
  }
  const want = JSON.parse(fs.readFileSync(FIXTURE, "utf8")) as Record<string, string[]>;
  for (const n of names) {
    const a = got[n],
      b = want[n] ?? [];
    const i = a.findIndex((s, j) => s !== b[j]);
    const ok = i < 0 && a.length === b.length;
    check(`typingKeyByKey ${n}`, ok, ok ? a[a.length - 1] : { at: i, got: a[i], main: b[i] });
  }
});
