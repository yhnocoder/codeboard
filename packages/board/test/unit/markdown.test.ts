// Markdown 往返：解析成文档再写回，要稳定，不乱转义；旧版（v0.1.7 手写渲染器）写的 Note 照样显示得合理
import { describe, expect, it } from "vitest";
import { parseMd, serializeMd } from "../../src/md/schema";
import { renderMd } from "../../src/md/render";
import { toggleTask } from "../../src/md/view";
import { cleanCompletion, completePrompt } from "@codeboard/core";

const rt = (s: string) => serializeMd(parseMd(s));
/** 写回一次后再往返，必须一字不变 */
const stable = (s: string) => { const a = rt(s); expect(rt(a)).toBe(a); return a; };
const same = (s: string) => expect(stable(s)).toBe(s);

describe("markdown round trip", () => {
  it("keeps identifiers with _ and * unescaped", () => {
    same("call block_manager.allocate and __init__ here");
    same("seq_len_q and _private and a_b_c");
    same("a * b and 2*3");
    same("a < b & c, x > y");
    same("snake_case_name in `code_span` and **bold_text**");
  });
  it("escapes only what would change meaning", () => {
    expect(rt("\\*not italic\\*")).toBe("\\*not italic\\*");
    expect(rt("\\# not a heading")).toBe("\\# not a heading");
    expect(rt("\\- not a list")).toBe("\\- not a list");
    expect(rt("a \\<b\\> tag")).toBe("a \\<b> tag");
    // 旧版存下的 \$…\$（打字时被转义的公式）：按 Pandoc 规则能当公式就当公式
    expect(rt("price \\$5\\$")).toBe("price $5$");
    expect(rt("costs \\$5 or \\$6")).toMatch(/^costs \\?\$5 or \\?\$6$/);
    stable("costs \\$5 or \\$6");
    stable("\\[not a link\\](x)");
  });
  it("math: $…$ inline, $$…$$ block, Pandoc rules for money", () => {
    same("cost $O(n^2)$ per step");
    same("$5 and $10 are prices");
    same("display $$x^2$$ inline");
    same("$$\nE = mc^2\n$$");
    const d = parseMd("a $x$ b\n\n$$\n\\sum_i x_i\n$$");
    expect(JSON.stringify(d)).toContain('"inlineMath"');
    expect(JSON.stringify(d)).toContain('"blockMath"');
    expect(JSON.stringify(d)).toContain("\\\\sum_i x_i");
  });
  it("task list", () => {
    same("- [ ] todo\n- [x] done");
    same("- [ ] outer\n  - [x] inner");
  });
  it("image", () => {
    same("![alt text](https://a.b/c.png)");
    same("![](assets/shot.png)");
    // 和字混在一段：图片是行内的，留在段里
    const d = parseMd("see ![x](a.png) here");
    expect(d.content!.map((n) => n.type)).toEqual(["paragraph"]);
    expect(d.content![0].content!.map((n) => n.type)).toEqual(["text", "image", "text"]);
  });
  it("details", () => {
    const s = "<details>\n<summary>More & less</summary>\n\nbody **text**\n\n- a\n- b\n\n</details>";
    expect(stable(s)).toBe("<details>\n<summary>More &amp; less</summary>\n\nbody **text**\n\n- a\n- b\n\n</details>");
    expect(rt("<details><summary>T</summary>\n\nx\n\n</details>\n\nafter")).toBe("<details>\n<summary>T</summary>\n\nx\n\n</details>\n\nafter");
    // 嵌套
    stable("<details>\n<summary>A</summary>\n\n<details>\n<summary>B</summary>\n\ninner\n\n</details>\n\n</details>");
  });
  it("[[card ref]]", () => {
    same("see [[Scheduler.schedule]] and [[My note]]");
    expect(JSON.stringify(parseMd("[[A b]]"))).toContain('"cardRef"');
  });
  it("footnotes", () => {
    same("text[^1] more[^2]\n\n[^1]: first note\n[^2]: second");
    // 标签按出现顺序重新编号
    expect(rt("a[^x] b[^y]\n\n[^y]: Y\n[^x]: X")).toBe("a[^1] b[^2]\n\n[^1]: X\n[^2]: Y");
  });
  it("table (GFM)", () => {
    const a = stable("| op | cost |\n| --- | --- |\n| a_b | 1 |\n| x \\| y | 2 |");
    expect(a).toContain("a_b");
    expect(a).toContain("x \\| y");
    expect(a.split("\n")[1]).toMatch(/^\| -+ \| -+ \|$/);
  });
  it("code block with language", () => {
    same("```python\ndef f(x):\n    return x.block_manager * 2  # *not* md\n```");
    same("```\nplain\n```");
    // 内容里有 ``` 时围栏加长
    expect(stable("````md\n```\ninner\n```\n````")).toBe("````md\n```\ninner\n```\n````");
  });
  it("common blocks are stable", () => {
    same("# H1\n\n## H2\n\ntext **bold** *it* ~~gone~~ `code` [link](https://x.y/a_b)");
    same("> quote\n\n1. one\n2. two\n\n- a\n  - b\n- c");
    same("line one\nline two");
    same("hard  \nbreak");
    same("see https://github.com/x/y_z now");
    same("a\n\n---\n\nb");
  });
  it("idempotent on a mixed note", () => {
    stable([
      "## block_manager.allocate", "", "prefill 时 `Scheduler.schedule()` 先调 **block_manager** 分配 KV 页，见 [nano-vllm](https://github.com/x/nano-vllm)。", "",
      "- [ ] check `can_allocate(seq)`", "- [x] 按 hash 复用前缀块", "  - 命中就 `ref_count += 1`", "",
      "| 阶段 | 每步 token |", "| --- | --- |", "| prefill | 整个 prompt |", "| decode | 1 |", "",
      "```python", "def allocate(self, seq):", "    block = self._allocate_block(self.free_block_ids[0])", "```", "",
      "cost $O(n^2)$, see [[Scheduler]] and note[^1]", "", "$$", "\\frac{a}{b}", "$$", "",
      "<details>", "<summary>Why</summary>", "", "because __init__ builds all Blocks", "", "</details>", "", "[^1]: the footnote",
    ].join("\n"));
  });
});

describe("static render", () => {
  it("renders an old v0.1.7 note sensibly", () => {
    const old = "## Scheduler\nprefill first, then decode\n- waiting → running\n- block_manager.can_allocate(seq)\n\n> note\n\n$$\nE = mc^2\n$$\ncost $O(n)$ for $5 and $10, see https://x.y/a_b and **bold** *it*";
    const h = renderMd(old);
    expect(h).toContain("<h2>Scheduler</h2>");
    expect(h).toContain("prefill first, then decode");
    expect(h.match(/<li>/g)?.length).toBe(2);
    expect(h).toContain("block_manager.can_allocate(seq)");
    expect(h).toContain("<blockquote>");
    expect(h).toContain('class="math"');
    expect(h).toContain('class="katex');
    expect(h).toContain("for $5 and $10");
    expect(h).toContain('<a class="lnk" data-href="https://x.y/a_b">');
    expect(h).toContain("<strong>bold</strong>");
    expect(h).not.toMatch(/ href="/);
  });
  it("keeps soft line breaks as written (old notes were one line per paragraph)", () => {
    expect(renderMd("line one\nline two")).toBe("<p>line one\nline two</p>");
  });
  it("highlights code, renders chips, tasks, footnotes", () => {
    const h = renderMd("```python\ndef f(): return 1\n```\n\n- [x] done\n\nsee [[Card]][^1]\n\n[^1]: n");
    expect(h).toContain('<span class="hljs-keyword">def</span>');
    expect(h).toContain('data-type="taskItem"');
    expect(h).toContain('checked="checked"');
    expect(h).toContain('<span class="cref" data-cardref="Card">Card</span>');
    expect(h).toContain('<sup class="fnref">1</sup>');
    expect(h).toContain('<ol class="footnotes">');
  });
  it("leaves mermaid source for the lazy renderer", () => {
    expect(renderMd("```mermaid\ngraph TD; A-->B\n```")).toContain('<div class="mmd" data-src="graph TD; A-->B">');
  });
  it("does not let raw HTML through", () => {
    const h = renderMd("<script>alert(1)</script>\n\n<img src=x onerror=alert(1)>");
    expect(h).not.toMatch(/<script|<img[^>]*onerror/);
  });
  it("caches by content", () => {
    expect(renderMd("cache **me**")).toBe(renderMd("cache **me**"));
  });
});

describe("task toggle on static notes", () => {
  it("toggles the nth task, skipping code blocks", () => {
    const s = "- [ ] a\n```\n- [ ] not a task\n```\n- [x] b";
    expect(toggleTask(s, 0)).toBe("- [x] a\n```\n- [ ] not a task\n```\n- [x] b");
    expect(toggleTask(s, 1)).toBe("- [ ] a\n```\n- [ ] not a task\n```\n- [ ] b");
    expect(toggleTask(s, 2)).toBeNull();
  });
});

describe("AI completion text", () => {
  it("cleans model output", () => {
    expect(cleanCompletion("```\n the rest.\n```", "Hello and", "")).toBe(" the rest.");
    expect(cleanCompletion("Hello and more", "say Hello and", "")).toBe(" more");
    expect(cleanCompletion("next line\nsecond", "x ", "")).toBe("next line");
    expect(cleanCompletion("   ", "x", "")).toBe("");
  });
  it("prompt carries the text around the cursor", () => {
    const p = completePrompt("before text", "after text");
    expect(p).toContain("before text");
    expect(p).toContain("after text");
  });
});

describe("typed math and block source (v0.1.8 review)", () => {
  it("re-parses text that is Pandoc inline math", () => {
    const d = parseMd("a \\$\\frac{a}{b}\\$ b");
    expect(JSON.stringify(d)).toContain('"inlineMath"');
    expect(rt("a \\$\\frac{a}{b}\\$ b")).toBe("a $\\frac{a}{b}$ b");
  });
  // N1：打 $x$ 变成公式后 ⌘Z 撤回，存下的是 \$x$；显示和再次编辑都要是字面的 $x$（Typora 一样），不能又变回公式
  it("an escaped \\$ stays a literal dollar, shown and re-parsed", () => {
    const has = (s: string) => JSON.stringify(parseMd(s)).includes('"inlineMath"');
    expect(has("a \\$x$ b")).toBe(false);
    same("a \\$x$ b");
    expect(renderMd("a \\$x$ b")).toBe("<p>a $x$ b</p>");
    // 同一段里别的公式照常
    expect(has("a \\$x$ b $y$")).toBe(true);
    same("a \\$x$ b $y$");
    // 公式源码、代码里的 \$ 原样留着；链接地址里的 \$ 是 $
    expect(rt("$a\\$b$")).toBe("$a\\$b$");
    same("`\\$x$`");
    same("```\n\\$a$\n```");
    expect(rt("[t](http://x/\\$y)")).toBe("[t](http://x/$y)");
  });
  it("leaves money and $ followed by a digit alone", () => {
    same("pay $5 and $6 today");
    expect(JSON.stringify(parseMd("from $1 to $2"))).not.toContain("inlineMath");
  });
  it("inline $$x$$ stays display math in the paragraph", () => {
    same("sum $$x$$ here");
  });
  it("blockSource gives the block's Markdown without escaping", async () => {
    const { blockSource } = await import("../../src/md/schema");
    const p = parseMd("**b** and $m$").content![0];
    expect(blockSource(p)).toBe("**b** and $m$");
    expect(blockSource({ type: "paragraph", content: [{ type: "text", text: "x $y$ *z*" }] })).toBe("x $y$ *z*");
  });
});

describe("v0.1.8 review: data must not be rewritten", () => {
  it("inline images stay in their paragraph (#4)", () => {
    same("pic ![a](https://x.y/a.png) end");
    same("![cat](https://x.y/cat.png)");
  });
  it("typed HTML is escaped with a backslash, never an entity (#8)", () => {
    expect(rt("a \\<details> b")).toBe("a \\<details> b");
    expect(serializeMd({ type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "a <span>x</span> b" }] }] })).toBe("a \\<span>x\\</span> b");
  });
  it("<u> and <kbd> are formatting (#8, #15)", () => {
    same("a <u>under</u> b");
    same("press <kbd>Ctrl</kbd> now");
    expect(JSON.stringify(parseMd("a <u>x</u>"))).toContain('"underline"');
  });
  it("footnotes without text do not write empty definitions (#9)", () => {
    const d = parseMd("claim[^1] ok");
    expect(serializeMd(d)).toBe("claim[^1] ok");
    same("ref[^1]\n\n[^1]: the note");
  });
  it("code spans with backticks inside (#23)", () => {
    same("a ``x ` y`` b");
  });
});

describe("empty paragraphs", () => {
  it("are not written as blank lines or &nbsp;", () => {
    const code = { type: "codeBlock", attrs: { language: "python" }, content: [{ type: "text", text: "x" }] };
    const p = (t?: string) => (t ? { type: "paragraph", content: [{ type: "text", text: t }] } : { type: "paragraph" });
    expect(serializeMd({ type: "doc", content: [code, p(), p(), p("y")] })).toBe("```python\nx\n```\n\ny");
    expect(serializeMd({ type: "doc", content: [p("a"), p(), p("b")] })).toBe("a\n\nb");
    expect(serializeMd({ type: "doc", content: [{ type: "blockquote", content: [p("q"), p()] }] })).toBe("> q");
  });
});

describe("tables", () => {
  it("no extra blank lines around a table", () => {
    same("word here\n\n| a   | b   |\n| --- | --- |\n| 1   | 2   |\n\nafter");
  });
});
