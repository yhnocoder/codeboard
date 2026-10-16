// markdown-it 版和 v0.1.5 正则版逐字对比
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import * as path from "node:path";
import { md, inline } from "../../src/md";
import * as old from "./md-old";

const here = path.dirname(new URL(import.meta.url).pathname);

const lines = [
  "", "   ", "plain text", "  leading spaces", "trailing  ", "　",
  "# H1", "## H2 **bold**", "### H3 `code`", "#### h4 stays text", "#No space", "#   spaced  ", "# ",
  "- item", "* star item", "  - indented item", "-   wide", "- ", "1. one", "2) two", "10. ten", "- **b** and *i*",
  "> quote", ">quote no space", "> **b** `c`", "  > not quote",
  "**bold** text", "a **b** c **d**", "*it*", "a *b* c", "2*3*4", "x * y * z", "**a*", "*a**", "***x***",
  "`code`", "`a *b* c`", "``", "a ` b", "`x` and `y`", "`<b>&amp;</b>`",
  "$x^2$", "$5 and $10", "cost $5, then $x$", "\\$x$", "$$\\sum_i x_i$$", "a $$b$$ c", "$ x$", "$x $", "$x$1", "$x$.", "$$$a$$",
  "[link](https://example.com)", "[a **b**](http://x.y/z?q=1&r=2)", "[t](ftp://x)", "[t](https://a b)", "see [x](https://e.com).",
  "https://example.com/path", "go to https://a.b/c?d=e&f=\"g\" now", "(https://x.y)", "x https://a.b.", "nohttps://x", "http://a<b>c",
  "<b>raw html</b>", "<script>alert(1)</script>", "a & b < c > d \"q\" 'a'", "&copy; &amp;", "\\*not escaped\\*",
  "_under_ score_", "snake_case_name", "~~strike~~", "![img](https://x/y.png)", "<https://x.y>",
  "---", "***", "| a | b |", "    four-space indent", "\ttab",
  "混合 **中文** 和 `code` 以及 $a+b$",
];
const blocks = [
  "a\nb", "a\n\nb", "- a\n- b\n\n- c", "- a\n  - nested\n- b", "1. a\n2. b\n- c", "- a\ncontinued", "* a\n- b",
  "```\ncode <x>\n  more\n```\nafter", "```ts\nconst a = 1;\n```", "```\nunclosed\nlines", "``` \n```",
  "$$\n\\int_0^1 x\\,dx\n$$\ntext", "  $$  \nx\n$$", "$$\nunclosed",
  "> q1\n> q2", "# T\ntext\n- l", "a\r\nb\r\n", "trailing\n", "\n\n", "x\n\n\n\ny", "- a\n\n\n1. b",
  "# Why chunked prefill\nKeeps memory **bounded**: prefill admits waiting seqs until the `max_num_batched_tokens` budget runs out.",
];
// 测试和 e2e 里写过的 md 字符串
function harvested(): string[] {
  const files = ["../scenarios.ts", "../scenarios-web.ts", "../v015.ts", "../perf.ts"].map((f) => path.join(here, f));
  const out: string[] = [];
  for (const f of files) {
    let src = ""; try { src = readFileSync(f, "utf8"); } catch { continue; }
    for (const m of src.matchAll(/\bmd:\s*"((?:[^"\\]|\\.)*)"/g)) { try { out.push(JSON.parse(`"${m[1]}"`)); } catch { /* 拼出来的字符串 */ } }
  }
  return out;
}

describe("md (markdown-it) matches the v0.1.5 output", () => {
  const corpus = [...lines, ...blocks, ...harvested(), lines.join("\n"), blocks.join("\n\n")];
  it.each(corpus.map((s) => [JSON.stringify(s).slice(0, 60), s]))("md %s", (_, s) => { expect(md(s)).toBe(old.md(s)); });
  it.each(lines.map((s) => [JSON.stringify(s).slice(0, 60), s]))("inline %s", (_, s) => { expect(inline(s)).toBe(old.inline(s)); });
});

describe("md random lines", () => {
  // 随机拼出来的行（不含裸网址，见下一组）：和旧版逐字一致
  const parts = ["a", "b c", " ", "*", "**", "`", "$", "$$", "x", "1", "[t](https://e.com/x)", "(", ")", "#", "- ", "> ", "_", "\\", "&", "<", "\n", "中", "：", "[", "]", "!", "1. ", "```"];
  it("matches v0.1.5 on 5000 random inputs", () => {
    let seed = 7; const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
    for (let i = 0; i < 5000; i++) {
      let s = ""; for (let k = 1 + Math.floor(rnd() * 8); k > 0; k--) s += parts[Math.floor(rnd() * parts.length)];
      expect(md(s), JSON.stringify(s)).toBe(old.md(s));
    }
  });
});

describe("md intentional differences (v0.1.5 produced broken HTML)", () => {
  // 旧版先认裸网址、后认强调，网址里的 * 会把 <b>/<i> 塞进 data-href；现在网址里的字符原样
  it("bare URL followed by asterisks", () => {
    expect(old.md("https://a.b/c**x")).toContain('data-href="https://a.b/c<b>');
    expect(md("https://a.b/c**x")).toBe('<p><a class="lnk" data-href="https://a.b/c**x">https://a.b/c**x</a></p>');
  });
  // 旧版网址会吞掉后面的 `code` / $math$；现在网址到代码 / 公式前为止
  it("bare URL followed by code", () => {
    expect(md("https://a.b/c`x`")).toBe('<p><a class="lnk" data-href="https://a.b/c">https://a.b/c</a><code>x</code></p>');
  });
  // 链接文字里的裸网址：旧版套出 <a> 里的 <a>；现在只是文字
  it("bare URL inside link text", () => {
    expect(md("[see https://x.y](https://e.com)")).toBe('<p><a class="lnk" data-href="https://e.com">see https://x.y</a></p>');
  });
});
