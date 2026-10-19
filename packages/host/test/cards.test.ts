// ⌥B over several definitions (nano-vllm utils/context.py lines 5–27): one multi-segment card by default, ⇧⌥B one card per definition;
// neither drops a line (the dataclass's decorator and fields, _CONTEXT = Context() at line 16)
import * as fs from "node:fs";
import * as path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import type { CodeCard } from "@codeboard/core";
import { cardsFromEditor } from "../src/cards";
import { useWorkspace } from "../src/ws";
import { WS, nodeWorkspace } from "./node-workspace";
import { card, startTreeSitter } from "./helpers";

const abs = path.join(WS, "nanovllm/utils/context.py");
const ed = () => ({ path: abs, file: true, lang: "python", text: fs.readFileSync(abs, "utf8"), selections: [{ startLine: 5, startCol: 0, endLine: 27, endCol: 24 }], cursorLine: 27, selectionText: "" });
const ranges = (c: CodeCard) => c.segments.map((sg) => `${sg.symbol?.qual ?? sg.scope ?? "?"}:${sg.start}-${sg.end}`);
const want = ["Context:5-14", "<module>:16-16", "get_context:18-19", "set_context:21-23", "reset_context:25-27"];

beforeAll(async () => { useWorkspace(nodeWorkspace()); await startTreeSitter(); });

describe("cards from a selection over several definitions", () => {
  it("⌥B: one card, a segment per definition plus the module line between", async () => {
    const one = await cardsFromEditor(ed());
    expect("cards" in one && one.cards.map(ranges)).toEqual([want]);
    expect("cards" in one && (one.cards[0].members || one.ask)).toBeFalsy();
  });
  it("⇧⌥B: one card per definition, the module line as its own card; the fields-only dataclass is a plain card with decorator and fields", async () => {
    const sep = await cardsFromEditor(ed(), "separate");
    expect("cards" in sep && sep.cards.map((c) => ranges(c)[0])).toEqual(want);
    const ctx = "cards" in sep ? sep.cards[0] : undefined;
    expect(ctx?.members).toBeFalsy();
    expect(ctx?.segments[0].text[0]).toMatch(/^@dataclass/);
    expect(ctx?.segments[0].text).toHaveLength(10);
  });
  it("from a symbol (search, Add Function at Cursor): no empty member list; a class with methods is still a member-list card", async () => {
    expect((await card(abs, "Context")).card.members).toBeFalsy();
    expect((await card(path.join(WS, "nanovllm/engine/scheduler.py"), "Scheduler")).card.members).toBeTruthy();
  });
});
