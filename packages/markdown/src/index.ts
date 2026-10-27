// 只读入口：不带编辑器（@yhnocoder/markdown/editor，懒加载），不碰 Solid
export { parseMd, serializeMd, mdSchema, baseExtensions } from "./schema";
export { renderMd, renderMdInline, clearMdCache, mdCached } from "./render";
export { setAssetBase, setImageResolver, type ImageResolver, type ResolvedImage } from "./image";
export { hydrate, mdClick, toggleTask, setRefResolver, resolveRef, type RefTarget } from "./view";
export { setCodeHighlighter, highlightCode, cachedCode, colorCode, type CodeHighlighter } from "./code";
export { staticTextRange, docRange, type StaticTextRange } from "./selmap";
export { setMathPreamble, mathMacros, mathPreambleErrors } from "./math";
