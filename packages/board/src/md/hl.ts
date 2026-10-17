// 代码块着色：lowlight（highlight.js），只带常见的几种语言。颜色走代码卡的 --k-* 变量（styles.css 的 .hljs-*）
import { createLowlight } from "lowlight";
import python from "highlight.js/lib/languages/python";
import javascript from "highlight.js/lib/languages/javascript";
import typescript from "highlight.js/lib/languages/typescript";
import json from "highlight.js/lib/languages/json";
import bash from "highlight.js/lib/languages/bash";
import shell from "highlight.js/lib/languages/shell";
import c from "highlight.js/lib/languages/c";
import cpp from "highlight.js/lib/languages/cpp";
import rust from "highlight.js/lib/languages/rust";
import go from "highlight.js/lib/languages/go";
import java from "highlight.js/lib/languages/java";
import yaml from "highlight.js/lib/languages/yaml";
import sql from "highlight.js/lib/languages/sql";
import diff from "highlight.js/lib/languages/diff";
import xml from "highlight.js/lib/languages/xml";
import css from "highlight.js/lib/languages/css";
import markdown from "highlight.js/lib/languages/markdown";
import ini from "highlight.js/lib/languages/ini";

export const lowlight = createLowlight({ python, javascript, typescript, json, bash, shell, c, cpp, rust, go, java, yaml, sql, diff, xml, css, markdown, ini });
lowlight.registerAlias({ python: ["py"], javascript: ["js", "jsx"], typescript: ["ts", "tsx"], bash: ["sh", "zsh"], cpp: ["c++", "cc", "cuda", "cu"], xml: ["html"], yaml: ["yml"], ini: ["toml"] });

type Hast = { type: string; value?: string; tagName?: string; properties?: { className?: string[] }; children?: Hast[] };
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
function html(n: Hast): string {
  if (n.type === "text") return esc(n.value ?? "");
  const inner = (n.children ?? []).map(html).join("");
  if (n.type !== "element") return inner;
  const cls = n.properties?.className?.join(" ");
  return cls ? `<span class="${cls}">${inner}</span>` : inner;
}

/** 着好色的 HTML；不认识的语言（或没写语言）只转义 */
export function highlight(code: string, lang?: string | null): string {
  if (!lang || !lowlight.registered(lang)) return esc(code);
  try { return html(lowlight.highlight(lang, code) as Hast); } catch { return esc(code); }
}
