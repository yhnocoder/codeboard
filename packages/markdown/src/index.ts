// 只读入口：不带编辑器（@yhnocoder/markdown/editor，懒加载），不碰 Solid。
// The API for npm users (README); an export the board itself does not use is marked @public for the dead-code check
export { createMarkdown, type Markdown, type MarkdownOptions } from "./markdown";
export {
  parseMd,
  /** @public */
  serializeMd,
  mdBlockStarts,
  texBrackets,
} from "./schema";
export {
  IMAGE_DRAG_TYPE,
  draggedImage,
  type DraggedImage,
  /** @public */
  type ImageResolver,
  /** @public */
  type ResolvedImage,
} from "./image";
export { imageCaption, setImageCaption, tableCaption, setTableCaption } from "./caption";
export {
  /** @public */
  imagePlayback,
  setImagePlayback,
} from "./imageplay";
export {
  /** @public */
  type ImageAttrs,
  type ImagePlayback,
} from "./imageattrs";
export {
  /** @public */
  toggleTask,
  type RefTarget,
  type RefSeal,
  type RefBroken,
  /** @public */
  type Refs,
  /** @public */
  type ClickOpts,
} from "./view";
export {
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
  /** @public */
  type MathMacros,
} from "./math";
export {
  applyMdLayout,
  type MdLayout,
  /** @public */
  type TableLayout,
} from "./layout";
