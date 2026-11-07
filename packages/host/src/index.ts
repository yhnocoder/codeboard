// @codeboard/host 的入口：编辑器的壳（VS Code 插件）只从这里导入。测试用的工具在 @codeboard/host/testing
export { startHost, type Host } from "./start";
export type { HostEnv } from "./env";
export type { BoardView } from "./boards";
export type { BoardHub } from "./hub";
export type { Storage } from "./storage/boards";
export { FORWARDED_KEYS } from "./boards";
export type { BoardMarks } from "./marks";
export { treeChildren, type TreeNode } from "./boardtree";
export { BUNDLE_EXT } from "./bundle";
export { isScratchName } from "./scratchnames";
export { debounce } from "./ws";
/** Where the box binary for this platform is in a bin/ folder (the extension bundles them in its own) */
export { binIn } from "@codeboard/box";
export { COMMANDS, type CommandDecl, type CommandIcon, type CommandId } from "./commands";
