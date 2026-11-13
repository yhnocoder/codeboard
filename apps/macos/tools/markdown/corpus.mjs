// The synthetic Markdown the fixtures are made from: the cases of packages/markdown's tests, the syntax table of
// docs/markdown-guideline.md section 4, and combinations of them. Synthetic text only (no private boards).

const zh = ["调度器把请求分成批次", "每个批次在显存里保留键值缓存", "预填充和解码要分开处理", "注意力按块计算", "这一段说明原因"];
const en = ["The scheduler splits requests", "each block holds 256 tokens", "prefill runs before decode", "see the notes"];

/** inline texts: one paragraph's (or heading's, or cell's) source each */
export const inline = [
  // emphasis and its edge cases
  "**bold** and *italic* and ***both***",
  "a*b*c and 2*3*4 stay text, *pre*fill is italic",
  "__init__ and block_manager are names, _not emphasis_",
  "**粗体**紧跟中文，*斜体*也一样",
  "**unclosed bold and *one star",
  "***a** b*",
  "*a **b** c*",
  "**a *b* c**",
  "x**y**z and x*y*z",
  "~~struck~~ and ~sub~ and ^sup^ and H~2~O and 2^10^",
  "~~ not struck ~~ and ~ alone",
  "==highlight== and == not == and ==多字高亮==",
  "a ==b== c ===d=== e",
  "<u>underline</u> and <kbd>Ctrl</kbd>+<kbd>C</kbd>",
  "<span style=\"color:red\">red</span> and <b>bold tag</b> and <br> and <br/>",
  "vector<int> and <T> and <Foo> are words",
  "<!-- a comment --> visible after",
  // code
  "`code` and ``co`de`` and ` spaced ` and `kv_cache[i]`",
  "`unclosed code and *star*",
  "``` triple ``` inline",
  // links
  "[link](https://example.com/a/long/url) and [label with **bold**](https://example.com)",
  "[a](<url with spaces>) and [b](url \"title\") and [c](url 'title')",
  "[nested (parens)](https://example.com/a_(b)) text",
  "<https://example.com> and <someone@example.com>",
  "https://example.com/path?x=1. and www.example.com, and a@b.com",
  "[ref][label] and [label] and [label][] (no definitions)",
  "[unclosed link](https://example.com",
  "\\[not a link\\](x) and \\*not em\\*",
  // images
  "![alt](images/a.png)",
  "![alt](images/a.png \"a caption with *em*\")",
  "![alt](images/a.png){width=40%}",
  "![alt](images/a.png){width=40% frame=3 loop=true}",
  "![alt](images/a.png){width=0%} stays text, {height=3} too",
  "![a b](images/has space.png) broken",
  "text ![inline](i.png) in the middle and ![two](j.png){width=10.5%}",
  "![](data:image/svg+xml,<svg></svg>)",
  // math
  "$x_i^2$ and $\\frac{a}{b}$ and $$\\sum_k k$$ inline big",
  "$5 and $10 are money, \\$x$ is not math",
  "a $ b $ c and $x$y and $x$5",
  "$\\text{含中文的文字}$ and $\\operatorname{softmax}(x)$",
  "price \\$5 and $\\$ inside$",
  "**bold $x$ math** and *$y$*",
  // refs, emoji, annotations
  "[[Some note]] and [[标题#^abc-1]] and [[board/card#^x1/y2]]",
  "[[]] and [[ ]] and [[a\nb]]",
  ":smile: and :+1: and :not_an_emoji: and 1:100:",
  "{字|注释} and {text|note|purple below} and {a|b|green}",
  "{\\{x\\}|n} and {$\\frac{a}{b}$|formula} and {broken|",
  // breaks and escapes
  "line one  \nline two\\\nline three",
  "hard<br>break",
  "\\# not heading \\- not list \\> not quote",
  "tab\there and trailing spaces   ",
  "emoji 😀 and 𝕏 surrogate **𝕏bold𝕏**",
  "",
];

/** whole Markdown sources: block structure */
export const blocks = [
  "# Title\n\nSome **bold** text\n",
  "# Title\n\nFirst paragraph\nstill first.\n\n- a\n- b\n\n```py\nx = 1\n```\n\n$$\nx^2\n$$\n\n> quote\n\n![](assets/a.png){width=40%}\n\nlast",
  "just text",
  "",
  "a\n\n\n\n\nb",
  "a\n\nb",
  "## Heading ##\n### Heading with # inside\n#not heading\n####### seven",
  "Setext\n===\n\nSetext two\n---\n",
  "para\n# heading interrupts\npara again",
  "- a\n- b\n  - nested\n    - deeper\n- c",
  "1. one\n2. two\n3. three",
  "3) three\n4) four",
  "- a\n\n- b loose\n\n- c",
  "- [ ] todo\n- [x] done\n- [X] done too",
  "- [ ] task\n  - [ ] nested task\n  - [x] nested done\n- [ ] second",
  "- [ ] task\n\n  continuation paragraph\n- [ ] next",
  "- a\n- [ ] mixed task\n- b",
  "- [ ]\n- [x] empty first",
  "* star\n+ plus\n- dash",
  "1. ordered\n- bullet",
  "- item\n\n      indented code in item\n- next",
  "- item\nlazy continuation\n- next",
  "> quote line one\n> quote line two\nlazy line\n\n> second quote",
  "> # heading in quote\n> - list in quote\n> - more\n>\n> para in quote",
  "> nested\n>> deeper\n>>> deepest",
  "> - a\n- b",
  "```\nplain fence\n```",
  "~~~ts\nconst x = 1;\n~~~",
  "````md\n```inner```\n````",
  "```python title\ndef f():\n    pass\n```\nafter",
  "  ```\n  indented fence\n   more\n  ```",
  "```\nunclosed fence\nstill code",
  "    indented code\n    more code\n\npara",
  "para\n    not code (lazy)",
  "---\n***\n___\n- - -",
  "| a | b | c |\n|---|:---:|--:|\n| 1 | 2 | 3 |\n| 4 | 5 |",
  "| 阶段 **Stage** | 做什么 | 耗时 `ms` |\n| --- | --- | --- |\n| prefill | 一次处理整段提示，==所有 token== 并行 | 12.5 |\n\nTable: the stages",
  "| a `x|y` | b |\n|---|---|\n| `p|q` | \\| escaped |",
  "a | b\n--|--\n1 | 2",
  "| only header |\n|---|",
  "| a | b |\n|---|\n| mismatch |",
  "text before\n| a | b |\n|---|---|\n| 1 | 2 |",
  "$$x^2$$",
  "$$\n\\begin{aligned} a &= b \\\\ c &= d \\end{aligned}\n$$",
  "para\n$$\ny\n$$\nafter",
  "$$ inline $$ text after",
  "<div>\nhtml block\n</div>\n\npara",
  "<!-- comment block -->\n\npara",
  "<details>\n<summary>s</summary>\nbody\n</details>",
  "<Foo>\nnot html\n</Foo>",
  "[label]: https://example.com\n\n[label] reference",
  "[a]: x\n[a]: y\n\ntext",
  "para\n[def]: in paragraph",
  "![](images/a.png)\n\n![b](images/b.png \"caption\"){width=50%}",
  "line one  \nline two\n\nline three\\\nline four",
  "Table: not after table",
  "# 标题一\n\n" + zh.join("，") + "。\n\n## " + en[0] + "\n\n" + en.join(", ") + ".",
  "- " + zh[0] + "\n- " + en[1] + "\n\n1. " + zh[2] + "\n2. **" + en[2] + "**",
  "\t- tab indented\n\t\t- deeper tab",
  "-\n  empty first line item",
  "- \n- spaced empty",
  "1.\n2.\n3. last",
  "10. ten\n11. eleven",
  "> ```\n> code in quote\n> ```",
  "para\n\n\n",
  "\n\nleading blank lines",
  "trailing spaces   \n\n",
];

// combinations: every inline text in a paragraph, a heading, a list item, a quote and a table cell
for (const t of inline) {
  if (!t) continue;
  const oneLine = t.replace(/\n/g, " ");
  blocks.push(`${t}\n`, `## ${oneLine}`, `- ${oneLine}\n- second`, `> ${oneLine}`, `1. first\n2. ${oneLine}`);
  // a | in a cell has to be written \| (GFM splits cells on it)
  const cell = oneLine.replace(/\\\|/g, "\\\\|").replace(/(?<!\\)\|/g, "\\|");
  blocks.push(`| head | ${cell} |\n|---|---|\n| ${cell} | x |`);
}
blocks.push(
  // escaped pipes inside cells: an annotation, math and a reference
  "| a | b |\n|---|---|\n| {字\\|注} | $a\\|b$ |\n| [[ref]] | [[标题#^id]] |",
  "| {text\\|note\\|green} | `x\\|y` |\n|---|---|\n| ==h== | :smile: |",
  // line endings TS normalizes
  "# Title\r\n\r\npara one\r\nstill one\r\n\r\n- a\r\n- b\r\n",
  "a\rb\r\rc",
  "> quote\r\n> more\r\n\r\n```\r\ncode\r\n```",
  // HTML entities
  "&amp; &lt; &nbsp; &#x4e2d; and &copy; in text",
  "# &lt;Title&gt;\n\n- &amp;item",
  // footnotes and toc are unsupported: plain text, and the one-word definition still shows
  "[^1]: 词",
  "text with a note[^1]\n\n[^1]: the note",
  "[toc]\n\n# heading",
  "[^1]\n\n[toc] inline",
  // mermaid
  "```mermaid\ngraph TD\n  A[开始] --> B{判断}\n  B -->|是| C\n```",
  // images in links, lists, quotes and cells
  "[![logo](images/logo.png)](https://example.com)",
  "[text ![i](a.png){width=20%} more](https://example.com)",
  "- item ![i](images/a.png){width=40%}\n- ![only](images/b.png){width=30% loop=true}",
  "> ![q](images/q.png){width=50%}\n> caption line",
  "| img | x |\n|---|---|\n| ![c](images/c.png){width=10%} | y |",
  // containers holding blocks
  "- item\n\n  ```py\n  code in item\n  ```\n- next",
  "- item\n\n  $$\n  x^2\n  $$\n- next",
  "- item\n  1. sub one\n  2. sub two\n- next",
  "- item\n  - [ ] sub task\n  - [x] sub done\n- next",
  "- item\n   ```\n   indented fence in item\n   ```",
  "> ```js\n> code in quote\n> ```\n> after",
  "> $$\n> y\n> $$",
  "> 1. ordered in quote\n>    1. nested ordered",
  "> - [ ] task in quote\n> - [x] done in quote",
  "1. one\n   - [ ] task under ordered\n2. two",
  // math across a soft break
  "inline $a +\nb$ across lines",
  "$x\ny$ and $p\n\nq$ not across paragraphs",
);
// a long mixed note
blocks.push(
  [
    "# 调度 Scheduler",
    zh[0] + "，**" + zh[1] + "**，然后调用 `Scheduler.step()`。" + en[0] + " into batches; see [notes](https://example.com/n).",
    "## 公式",
    "块公式：",
    "$$\nE = mc^2 \\tag{1}\n$$",
    "行内 $x_i^2$ 和 ==高亮== 和 {注|note}。",
    "- [ ] " + zh[3],
    "- [x] " + en[3],
    "",
    "| a | b |\n|---|---|\n| 1 | 2 |",
    "",
    "> " + zh[4],
    "",
    "```cuda\n__global__ void k() {}\n```",
  ].join("\n\n"),
);

/** block-move cases (blockmove.ts): source, the blocks to move or cut, where to */
export const moves = [
  { src: "a\n\nb\n\nc", cut: [1], move: { blocks: [0], to: 3 } },
  { src: "- a\n- b\n\npara\n\n- c\n- d", cut: [0], move: { blocks: [2], to: 0 } },
  { src: "1. a\n2. b\n\n- x\n\n1. c", cut: [1], move: { blocks: [1], to: 0 } },
  { src: "# h\n\ntext\n\n```\ncode\n```\n\n| a |\n|---|\n| 1 |", cut: [2, 3], move: { blocks: [3], to: 1 } },
  { src: "para one\n\n$$\nx\n$$\n\npara two", cut: [1], move: { blocks: [0, 1], to: 3 } },
  { src: "a\n\n> quote\n> more\n\nb", cut: [1], move: { blocks: [1], to: 0 } },
  { src: "a\n\n- [ ] t1\n- [x] t2\n\nb", cut: [1], move: { blocks: [1], to: 3 } },
  { src: "a\n\n| x | y |\n|---|---|\n| 1 | 2 |\n\nTable: cap\n\nb", cut: [1], move: { blocks: [1], to: 0 } },
  { src: "a\n\n- x\n  - y\n    - z\n- w\n\nb", cut: [1], move: { blocks: [1], to: 3 } },
  { src: "a\n\nb\n\nc", cut: [0, 1], move: { blocks: [0], to: 3 } },
  { src: "- a\n\n# h\n\n- b", cut: [1], move: { blocks: [0], to: 3 } },
];
