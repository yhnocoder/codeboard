// 只读入口：不带编辑器（@yhnocoder/markdown/editor，懒加载），不碰 Solid
export { parseMd, serializeMd, mdSchema, baseExtensions, mdBlockStarts, texBrackets } from "./schema";
export { renderMd, renderMdInline, clearMdCache, mdCached } from "./render";
export { setAssetBase, setImageResolver, type ImageResolver, type ResolvedImage } from "./image";
export { imageCaption, setImageCaption } from "./caption";
export { hydrate, mdClick, toggleTask, setRefResolver, resolveRef, paintRef, type RefTarget, type RefBroken } from "./view";
export { setCodeHighlighter, highlightCode, cachedCode, colorCode, type CodeHighlighter } from "./code";
export { staticTextRange, staticDomRange, docRange, type StaticTextRange } from "./selmap";
export { toggleStaticMark, staticMarkActive, type StaticMark } from "./marks";
export { setMathPreamble, mathMacros, mathPreambleErrors } from "./math";
export { undoubleTex } from "./doubled";
export { applyMdLayout, type MdLayout, type TableLayout } from "./layout";
