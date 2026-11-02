// 只读入口：不带编辑器（@yhnocoder/markdown/editor，懒加载），不碰 Solid。
// The API for npm users (README); an export the board itself does not use is marked @public for the dead-code check
export {
  parseMd,
  /** @public */
  serializeMd,
  mdBlockStarts,
  texBrackets,
} from "./schema";
export { renderMd, renderMdInline, mdCached } from "./render";
export {
  /** @public */
  setAssetBase,
  setImageResolver,
  IMAGE_DRAG_TYPE,
  draggedImage,
  type DraggedImage,
  /** @public */
  type ImageResolver,
  /** @public */
  type ResolvedImage,
} from "./image";
export { imageCaption, setImageCaption } from "./caption";
export {
  hydrate,
  mdClick,
  /** @public */
  toggleTask,
  setRefResolver,
  paintRef,
  type RefTarget,
  type RefBroken,
} from "./view";
export {
  setCodeHighlighter,
  /** @public */
  type CodeHighlighter,
} from "./code";
export {
  staticTextRange,
  staticDomRange,
  /** @public */
  docRange,
  type StaticTextRange,
} from "./selmap";
export { toggleStaticMark, staticMarkActive, type StaticMark } from "./marks";
export {
  setMathPreamble,
  /** @public */
  mathMacros,
  mathPreambleErrors,
} from "./math";
export { undoubleTex } from "./doubled";
export {
  applyMdLayout,
  type MdLayout,
  /** @public */
  type TableLayout,
} from "./layout";
