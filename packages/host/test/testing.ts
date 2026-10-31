// @codeboard/host/testing：白板的场景、harness、Storybook 的数据直接用宿主的一部分（真分析、真调用解析、真存储），
// 加上宿主测试自己的 Node 版 Workspace 和代码生成的测试图片
export * from "./images";
export { nodeWorkspace, type TestWorkspace } from "./node-workspace";
export { analysisOf, analysisReady, startAnalysis } from "../src/analysis";
export { cardForFileSym } from "../src/cards";
export { forgetDefs } from "../src/defcache";
export { deepseekComplete } from "../src/deepseek";
export { inlineFor, setMediaDir } from "../src/exports";
export { readAsset, readImageUri, saveNoteImage } from "../src/images";
export { resetImageAiCache, runImageAi, SYS_FOCUS } from "../src/imageai";
export { nameIndexReady, resetIndex, startNameIndex } from "../src/nameindex";
export { nodeFs } from "../src/nodefs";
export { callVars, dispatchAt, expand, peek } from "../src/resolve";
export { captureRun, runApply } from "../src/runs";
export { genSource, search, searchName, searchPick } from "../src/search";
export type { Storage } from "../src/storage";
export { highlight, viewsFor } from "../src/views";
export { langOf, useWorkspace } from "../src/ws";
