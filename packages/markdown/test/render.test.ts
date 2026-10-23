// @vitest-environment happy-dom
// 静态显示和编辑器用的是同一份 renderHTML：同一篇文档，render.ts 拼出来的 HTML 和 TipTap 的 getHTML（ProseMirror 的 DOMSerializer）一样；
// 显示时只有文档里写明的几处不同（公式、Mermaid、目录、图片、链接、只有一段的列表项 / 格子）
import { describe, expect, it } from "vitest";
import { getHTMLFromFragment } from "@tiptap/core";
import { mdSchema, parseMd } from "../src/schema";
import { renderMd, schemaHtml } from "../src/render";
import { colorCode, setCodeHighlighter } from "../src/code";
import { hydrate } from "../src/view";

const DOCS = [
  "# Title\n\nsome **bold** *it* ~~s~~ `code` <u>u</u> <kbd>K</kbd> ==hl== H~2~O x^2^ :tada: [[Card]]",
  "- a\n- b\n  - nested\n\n1. one\n2. two\n\n- [ ] todo\n- [x] done **too**",
  "> quote\n\n---\n\n```python\ndef f(x):\n    return x < 1 && \"q\"\n```\n\nline  \nbreak",
  "| a | b |\n| - | - |\n| 1 | 2 |",
  "<details>\n<summary>More</summary>\n\nbody\n\n</details>\n\ntext[^1]\n\n[^1]: note",
];
/** 浏览器解析一遍：属性的转义、style 的写法一致 */
const norm = (h: string) => {
  const d = document.createElement("div");
  d.innerHTML = h;
  for (const e of d.querySelectorAll<HTMLElement>("[style]")) e.setAttribute("style", e.style.cssText);
  return d.innerHTML;
};

describe("static render = editor HTML", () => {
  for (const md of DOCS) {
    it(JSON.stringify(md.slice(0, 30)), () => {
      const doc = mdSchema().nodeFromJSON(parseMd(md));
      expect(norm(schemaHtml(doc))).toBe(norm(getHTMLFromFragment(doc.content, mdSchema())));
    });
  }
  it("display differs only where documented", () => {
    const h = renderMd("- one\n\n[t](https://a.b)\n\n```mermaid\ngraph TD\n```\n\n[toc]\n\n## H");
    expect(h).toContain("<li>one</li>");
    expect(h).toContain('<a class="lnk" data-href="https://a.b">t</a>');
    expect(h).toContain('<div class="mmd" data-src="graph TD">');
    expect(h).toContain('<nav data-type="toc" class="md-toc"><div class="l2">H</div></nav>');
  });
});

describe("code blocks take the host's highlighting", () => {
  it("plain text first, coloured when the host answers, cached after", async () => {
    const asked: string[] = [];
    // 语言名换成正式 id 由用的一方给（白板用 core 的 langId）：py 和 python 是同一份缓存
    setCodeHighlighter(async (text, lang) => { asked.push(lang); return `<span class="kw">${text}</span>`; }, (l) => (l === "py" ? "python" : l));
    // 静态显示给的代码块（renderMd 的输出再过 DOMPurify，这里的 DOM 实现和它合不来，直接写）
    const block = (lang: string) => `<pre class="md-code" data-lang="${lang}"><code>return</code></pre>`;
    const el = document.createElement("div");
    el.innerHTML = block("py");
    hydrate(el, el.innerHTML);
    expect(el.querySelector("code")!.innerHTML).toBe("return");
    await new Promise((r) => setTimeout(r, 0));
    expect(el.querySelector("code")!.innerHTML).toBe('<span class="kw">return</span>');
    expect(asked).toEqual(["python"]);
    // 再画一遍：缓存里有，马上换，不再问
    const el2 = document.createElement("div");
    el2.innerHTML = block("python");
    colorCode(el2);
    expect(el2.querySelector("code")!.innerHTML).toBe('<span class="kw">return</span>');
    expect(asked).toEqual(["python"]);
  });
});
