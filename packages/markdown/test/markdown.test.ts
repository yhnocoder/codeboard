// @vitest-environment jsdom
// Markdown 往返（jsdom：静态显示整篇过 DOMPurify，happy-dom 解析时会丢掉开头的元素）：解析成文档再写回，要稳定，不乱转义；旧版手写渲染器写的 Note 照样显示得合理
import { describe, expect, it } from "vitest";
import { parseMd, serializeMd } from "../src/schema";
import { renderMd } from "../src/render";
import { toggleTask } from "../src/view";
import { getSchema, type JSONContent } from "@tiptap/core";
import { Node as PMNode } from "@tiptap/pm/model";
import { baseExtensions } from "../src/schema";

const schema = getSchema(baseExtensions);

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
  it("renders a note written for the old hand-written renderer sensibly", () => {
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
  it("renders code for the host highlighter, chips, tasks, footnotes", () => {
    const h = renderMd("```python\ndef f(): return 1\n```\n\n- [x] done\n\nsee [[Card]][^1]\n\n[^1]: n");
    expect(h).toContain('<pre class="md-code" data-lang="python"><code>def f(): return 1</code></pre>');
    expect(h).toContain('data-type="taskItem"');
    expect(h).toContain('checked="checked"');
    expect(h).toContain('<span class="cref" data-cardref="Card">Card</span>');
    expect(h).toContain('<sup class="fnref">1</sup>');
    expect(h).toContain('<ol class="footnotes">');
  });
  it("draws no footnote list while no footnote has a definition", () => {
    expect(renderMd("claim[^1] and more[^2]")).not.toContain("footnotes");
    expect(renderMd("claim[^1] and more[^2]\n\n[^2]: only this")).toContain('<ol class="footnotes">');
  });
  it("leaves mermaid source for the lazy renderer", () => {
    expect(renderMd("```mermaid\ngraph TD; A-->B\n```")).toContain('<div class="mmd" data-src="graph TD; A-->B">');
  });
  it("shows raw HTML through DOMPurify: harmless tags stay, scripts and handlers go", () => {
    const h = renderMd("<script>alert(1)</script>\n\n<img src=x onerror=alert(1)>");
    expect(h).not.toMatch(/<script|onerror/);
    expect(h).toContain('<img src="x">');
    expect(renderMd("a <u>b</u> <kbd>K</kbd> <!-- hidden --> c")).toBe("<p>a <u>b</u> <kbd>K</kbd>  c</p>");
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

describe("typed math and block source", () => {
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
  // #11：编辑器里光标处展开的原文（mdSrc 标记）写出来时先收回去，不会被当成字转义，也不会把 "## " 写两遍
  it("open source at the caret is written back as Markdown, not as escaped text", () => {
    const src = (text: string) => ({ type: "text", text, marks: [{ type: "mdSrc" }] });
    const p = (...content: object[]) => ({ type: "doc", content: [{ type: "paragraph", content }] });
    expect(serializeMd(p({ type: "text", text: "x " }, src("**bo**"), { type: "text", text: " y" }))).toBe("x **bo** y");
    expect(serializeMd(p(src("*bo**")))).not.toContain("mdSrc");
    expect(serializeMd(p({ type: "text", text: "a " }, src("$x$")))).toBe("a $x$");
    const h = (level: number, ...content: object[]) => ({ type: "doc", content: [{ type: "heading", attrs: { level }, content }] });
    expect(serializeMd(h(2, src("### "), { type: "text", text: "hd" }))).toBe("### hd");
    expect(serializeMd(h(2, src("## x"), { type: "text", text: "hd" }))).toBe("## xhd");
    // ## 改坏了：变回普通段落，字照留
    const bad = parseMd(serializeMd(h(2, src("##"), { type: "text", text: "hd" }))).content![0];
    expect(bad.type).toBe("paragraph");
    expect(bad.content?.map((c) => c.text).join("")).toBe("##hd");
  });
  // #27：编辑器里打的 \*（\ 带 mdEsc 标记）写出来就是 \*，不会变成 \\\*；读回来是字面的 *
  it("a typed backslash escape is written as typed", () => {
    const esc = { type: "text", text: "\\", marks: [{ type: "mdEsc" }] };
    const doc = (...content: object[]) => ({ type: "doc", content: [{ type: "paragraph", content }] });
    const md = serializeMd(doc({ type: "text", text: "a " }, esc, { type: "text", text: "*not" }, esc, { type: "text", text: "* b" }));
    expect(md).toBe("a \\*not\\* b");
    same(md);
    expect(JSON.stringify(parseMd(md))).not.toContain('"italic"');
    expect(serializeMd(doc({ type: "text", text: "x " }, esc, { type: "text", text: "# y" }))).toBe("x \\# y");
    // 后面没有字的 \：就是一个 \
    expect(serializeMd(doc({ type: "text", text: "end " }, esc))).toBe(serializeMd(doc({ type: "text", text: "end \\" })));
  });
  // #32：==高亮==、H~2~O、x^2^；~~删除线~~ 照旧；读不成这些的 ~ ^ == 不转义（以前 H~2~O 会存成 H\~2\~O）
  it("highlight, subscript and superscript", () => {
    same("==hi== and H~2~O and x^2^");
    const j = JSON.stringify(parseMd("==hi== and H~2~O and x^2^"));
    for (const m of ["highlight", "subscript", "superscript"]) expect(j).toContain(`"${m}"`);
    same("~~s~~ t");
    expect(JSON.stringify(parseMd("~~s~~"))).toContain('"strike"');
    same("a ~ b and ~/path, a ^ b, x == y");
    // 字面的：写回稳定，读回来还是字
    const lit = stable("H\\~2\\~O and x\\^2\\^ and \\==no==");
    expect(JSON.stringify(parseMd(lit))).not.toMatch(/subscript|superscript|highlight/);
    expect(renderMd("==a== b~2~ c^3^")).toBe("<p><mark>a</mark> b<sub>2</sub> c<sup>3</sup></p>");
  });
  it("==highlight== parses to the highlight mark and serializes back with other marks inside and around it", () => {
    for (const md of ["==hi==", "a ==two words== b", "==a **b** c==", "==**bold hl**==", "==`code` inside==", "==*x*== and ==~~y~~=="]) same(md);
    // the highlight is the outermost mark (one unbroken background), so a highlight inside bold is written with == outside
    expect(stable("**==bold hl==**")).toBe("==**bold hl**==");
    const marks = (md: string) => { const out: string[] = []; const w = (n: JSONContent) => { for (const m of n.marks ?? []) out.push(m.type); n.content?.forEach(w); }; w(parseMd(md)); return out; };
    expect(marks("a ==two words== b")).toEqual(["highlight"]);
    expect(marks("==a **b** c==").sort()).toEqual(["bold", "highlight", "highlight", "highlight"]);
    // a highlight mark made in the editor is written as ==…==
    const d: JSONContent = { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "see " }, { type: "text", text: "this", marks: [{ type: "highlight" }] }] }] };
    expect(serializeMd(d).trim()).toBe("see ==this==");
    // not highlights: spaces just inside the markers, a lone ==, ===
    for (const md of ["a == b == c", "x == y", "== spaced =="]) expect(marks(md), md).toEqual([]);
    // the static render uses the same <mark> the editor draws
    expect(renderMd("a ==two **b**== c")).toBe("<p>a <mark>two <strong>b</strong></mark> c</p>");
  });
  // #30：单独一行的 [toc] 是目录，显示时列出所有标题；段落里的 [toc] 字照留
  it("[toc] is a table of contents", () => {
    same("[toc]\n\n# A\n\n## B");
    expect(JSON.stringify(parseMd("[TOC]\n\n# A"))).toContain('"toc"');
    const h = renderMd("[toc]\n\n# A\n\n## B \\<i>\n\ntext");
    expect(h).toContain('<div class="l1">A</div><div class="l2">B &lt;i&gt;</div>');
    expect(renderMd("[toc]")).toContain("No headings yet");
    expect(renderMd("[toc]\n\n# Cost $1 and $& x")).toContain('<div class="l1">Cost $1 and $&amp; x</div>');
    same("see [toc] here");
    const lit = stable("\\[toc]");
    expect(JSON.stringify(parseMd(lit))).not.toContain('"toc"');
  });
  // #31：:smile: 存成短名，显示成表情字；不认识的名字、紧跟在字母数字后面的（1:100:）、代码里的照留；字面的 :smile: 转义冒号
  it(":name: is an emoji", () => {
    same("hi :smile: and :+1:");
    expect(JSON.stringify(parseMd("hi :smile:"))).toContain('"emoji"');
    expect(renderMd("hi :tada:")).toBe('<p>hi <span class="md-emoji" data-emoji="tada" title=":tada:">🎉</span></p>');
    for (const t of ["a :nosuchname: b", "ratio 1:100: x", "`:smile:`", "at 10:30:00"]) {
      same(t);
      expect(JSON.stringify(parseMd(t))).not.toContain('"emoji"');
    }
    const lit = stable("\\:smile:");
    expect(JSON.stringify(parseMd(lit))).not.toContain('"emoji"');
    expect(JSON.stringify(parseMd(lit))).toContain(":smile:");
  });
  it("leaves money and $ followed by a digit alone", () => {
    same("pay $5 and $6 today");
    expect(JSON.stringify(parseMd("from $1 to $2"))).not.toContain("inlineMath");
  });
  it("inline $$x$$ stays display math in the paragraph", () => {
    same("sum $$x$$ here");
  });
  it("blockSource gives the block's Markdown without escaping", async () => {
    const { blockSource } = await import("../src/schema");
    const p = parseMd("**b** and $m$").content![0];
    expect(blockSource(p)).toBe("**b** and $m$");
    expect(blockSource({ type: "paragraph", content: [{ type: "text", text: "x $y$ *z*" }] })).toBe("x $y$ *z*");
  });
});

describe("data must not be rewritten", () => {
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

describe("HTML written in a note", () => {
  it("inline tags and comments are written back unchanged", () => {
    same('a <span style="color:red">red</span> b');
    same("a <!-- note to self --> b");
    same('x <abbr title="Hyper Text">HTML</abbr> and <sup>2</sup> y');
    same("costs <span>\\$5</span> each");
  });
  it("<br> is a hard break", () => {
    expect(parseMd("line<br>next").content![0].content!.map((n) => n.type)).toEqual(["text", "hardBreak", "text"]);
  });
  it("block HTML and comments are written back unchanged", () => {
    same("<!-- hidden -->\n\npara");
    same('<div align="center">\n<b>centered</b>\n</div>\n\nafter');
    same("before\n\n<!--\nmulti\nline\n-->");
  });
  it("is kept as its own node, so the editor can show it", () => {
    expect(parseMd("a <span>x</span> b").content![0].content!.map((n) => n.type)).toEqual(["text", "htmlInline", "text"]);
    expect(parseMd("<!-- c -->").content!.map((n) => n.type)).toEqual(["htmlBlock"]);
    expect(() => PMNode.fromJSON(schema, parseMd("<div>x</div>\n\na <i>b</i> <!-- c -->")).check()).not.toThrow();
  });
  it("comments are not shown in the static view", () => {
    expect(renderMd("a <!-- secret --> b\n\n<!-- block secret -->")).not.toContain("secret");
  });
});

describe("a paragraph that is only an image", () => {
  it("is still a paragraph, so the document fits the schema", () => {
    for (const s of ["![i](a.png)", "a\n\n![i](a.png)", "![i](a.png)\n\nb"]) {
      const d = parseMd(s);
      expect(d.content!.map((n) => n.type)).toEqual(s.split("\n\n").map(() => "paragraph"));
      expect(() => PMNode.fromJSON(schema, d).check()).not.toThrow();
      same(s);
    }
  });
});

describe("text at the start of a line that reads as a block", () => {
  const para = (...cs: JSONContent[]): JSONContent => ({ type: "doc", content: [{ type: "paragraph", content: cs }] });
  const text = (t: string): JSONContent => ({ type: "text", text: t });
  const br: JSONContent = { type: "hardBreak" };
  /** 写出再读回来还是这一段（同样的字、同样的硬换行） */
  const keeps = (d: JSONContent) => {
    const md = serializeMd(d);
    expect(parseMd(md), md).toEqual(d);
  };
  const MARKERS = ["- milk", "+ x", "* x", "-", "# x", "###### x", "> x", "1. x", "1) x", "12. x", "---", "***", "___", "_ _ _", "- - -", "===", "--", "[toc]", "[^1]: x"];
  it("is escaped at the start of a paragraph", () => {
    for (const m of MARKERS) keeps(para(text(m)));
  });
  it("is escaped after a hard break", () => {
    for (const m of MARKERS) keeps(para(text("before"), br, text(m)));
  });
  it("is escaped after a newline inside the text", () => {
    for (const m of MARKERS) expect(parseMd(serializeMd(para(text(`before\n${m}`)))).content, m).toHaveLength(1);
  });
  it("an ordered-list marker escapes its dot, which reads back as the same text", () => {
    expect(serializeMd(para(text("1. x")))).toBe("1\\. x");
    same("1\\. x");
    same("2\\) y");
  });
  it("is left alone in the middle of a line", () => {
    same("a - b and 1. c and # d");
    same("**b** - x");
  });
});
