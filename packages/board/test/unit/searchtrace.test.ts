// @vitest-environment jsdom
// ⌘K's session trace: the queries typed on the way to a later one are dropped (unless something was picked, marked or
// judged under them), and the whole session goes to the host once
import { describe, expect, it } from "vitest";
import type { SearchItem, SearchTrace } from "@codeboard/core";
import { sent } from "./host";
import { startTrace } from "../../src/ui/searchtrace";

const card = (label: string): SearchItem => ({ kind: "card", label, detail: "", board: "b", card: label });
const last = () => (sent.filter((m) => m.type === "searchTrace").at(-1) as { trace: SearchTrace }).trace;

describe("search trace", () => {
  it("keeps the queries that were not just the start of a later one, and those used for a mark", () => {
    const t = startTrace("all");
    for (const q of ["b", "bl", "blo", "bloc", "block"]) t.words(q, [card(q)]);
    t.mark(card("bl"), "bl", true);
    t.words("cache", []);
    t.words("ca", []);
    t.send();
    expect(last().queries.map((q) => q.q)).toEqual(["bl", "block", "cache", "ca"]);
    expect(last().marks).toEqual([{ ref: "b:bl", label: "bl", q: "bl", good: true }]);
  });

  it("sends once, and nothing for a session where nothing was typed or said", () => {
    const n = sent.length;
    const t = startTrace("all");
    t.send();
    t.send();
    expect(sent.length).toBe(n);
  });
});
