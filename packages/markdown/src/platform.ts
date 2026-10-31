/** The browser says it runs on a Mac: the default where the caller doesn't tell (MdEditorOpts.isMac, FindOpts.isMac) */
export const IS_MAC = typeof navigator !== "undefined" && /Mac|iP(hone|[oa]d)/.test(navigator.platform);
