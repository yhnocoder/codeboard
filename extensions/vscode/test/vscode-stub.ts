// 给宿主性能测试用的假 vscode 模块：只有一个工作区根，没有打开的文档。
export const WS = "/tmp/codeboard-perf/ws";
export const workspace = {
  workspaceFolders: [{ uri: { fsPath: WS }, name: "ws", index: 0 }],
  textDocuments: [] as unknown[],
  getWorkspaceFolder: () => ({ uri: { fsPath: WS } }),
};
export const Uri = { file: (fsPath: string) => ({ fsPath }) };
