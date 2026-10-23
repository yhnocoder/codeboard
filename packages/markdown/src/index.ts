// @codeboard/markdown：Markdown 的解析 / 写回、静态显示（HTML 字符串 + 挂上页面后的 hydrate）。只读的地方用这个入口就够，
// 不带编辑器；编辑器是 @codeboard/markdown/editor（懒加载），代码编辑器是 @codeboard/markdown/code-editor。
// 样式：@codeboard/markdown/katex.css（公式）、@codeboard/markdown/style.css（用主题的 CSS 变量，见 markdown.css 开头）。
// 用的一方给的东西都是注册进来的：代码着色（setCodeHighlighter）、[[引用]] 找目标（setRefResolver）、图片资源目录（setAssetBase）、
// 点击时打开链接 / 引用（mdClick 的参数）
export { parseMd, serializeMd, mdSchema, baseExtensions } from "./schema";
export { renderMd, renderMdInline, clearMdCache, mdCached, setAssetBase } from "./render";
export { hydrate, mdClick, toggleTask, setRefResolver, resolveRef, type RefTarget } from "./view";
export { setCodeHighlighter, highlightCode, cachedCode, colorCode, type CodeHighlighter } from "./code";
