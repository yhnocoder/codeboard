// Auto Focus's check of the model's reply: only ==…== and **…** may be added; code, formulas, links, structure and existing marks
// must come back exactly as they were
import { describe, expect, it } from "vitest";
import { checkFocus } from "../../src/md/focusmarks";

const MD = "The scheduler batches `prefill` requests.\n\n- A *block table* maps sequences, see [docs](https://x.test/a_b).\n- Cost: $O(n)$ per ==step==.\n\n```py\nx = 1  # cache\n```";

describe("Auto Focus check", () => {
  it("accepts added highlights and bold, counts them and keeps the original's surrounding whitespace", () => {
    const reply = "The ==scheduler== batches `prefill` requests.\n\n- A *block table* maps **sequences**, see [docs](https://x.test/a_b).\n- Cost: $O(n)$ per ==step==.\n\n```py\nx = 1  # cache\n```";
    expect(checkFocus(`\n${MD}\n\n`, reply)).toEqual({ md: `\n${reply}\n\n`, hl: 1, bold: 1 });
  });

  it("takes the reply out of <document> tags or a fence around it", () => {
    const md = "Paged attention keeps blocks.";
    const r = "==Paged attention== keeps blocks.";
    expect(checkFocus(md, `<document>\n${r}\n</document>`)).toMatchObject({ md: r });
    expect(checkFocus(md, "```markdown\n" + r + "\n```")).toMatchObject({ md: r });
  });

  it("rejects a reply that changes, adds or drops a word, or drops an existing mark", () => {
    expect(checkFocus("The cache is full.", "The ==cache== is **almost** full.")).toEqual({ why: "changed" });
    expect(checkFocus("The cache is full.", "The ==cache== is full")).toEqual({ why: "changed" });
    expect(checkFocus("A *block table* here.", "A block table here.")).toEqual({ why: "changed" });
    expect(checkFocus("A ==tensor== here.", "A tensor here.")).toEqual({ why: "changed" });
  });

  it("rejects marks inside code spans, code blocks, formulas and link URLs, and around code", () => {
    expect(checkFocus("Call `run_all` now.", "Call `==run_all==` now.")).toEqual({ why: "changed" });
    expect(checkFocus("Call `run_all` now.", "Call **`run_all`** now.")).toEqual({ why: "changed" });
    expect(checkFocus("```\nx = y\n```", "```\n**x** = y\n```")).toEqual({ why: "changed" });
    expect(checkFocus("Cost $a + b$ here.", "Cost $==a== + b$ here.")).toEqual({ why: "changed" });
    expect(checkFocus("$$\na + b\n$$", "$$\n**a** + b\n$$")).toEqual({ why: "changed" });
    expect(checkFocus("See [docs](https://x.test/a).", "See [docs](https://x.test/**a**).")).toEqual({ why: "changed" });
  });

  it("rejects markers that don't pair up or break the structure", () => {
    expect(checkFocus("A cache here.", "A ==cache here.")).toEqual({ why: "changed" });
    expect(checkFocus("- item one", "**- item one**")).toEqual({ why: "changed" });
    expect(checkFocus("# Title\n\ntext", "**#** Title\n\ntext")).toEqual({ why: "changed" });
  });

  it("says when nothing was marked", () => {
    expect(checkFocus("Plain words.", "Plain words.")).toEqual({ why: "same" });
  });
});
