import Foundation

/// What a key does to a `CodeEditor`
public enum CodeCommand: Hashable, Sendable {
  case move(CodeEditor.Motion, forward: Bool, extend: Bool)
  case deleteBackward, deleteForward, deleteToLineEnd
  case deleteGroup(forward: Bool)
  case deleteLineBoundary(forward: Bool)
  case newline, indent, outdent, toggleComment, indentMore, indentLess
  case moveLines(down: Bool)
  case copyLines(down: Bool)
  case deleteLines, selectLine, selectAll, splitLine, transpose
  case undo, redo
}

/// A Mac's keys in a code editor: the web side's (CodeMirror's default and history keymaps, as a Mac has them, under
/// packages/markdown/src/cm/editor.ts's own). Names are CodeMirror's: modifiers in the order Shift, Meta (⌘), Ctrl,
/// Alt (⌥), then the key (`name(_:shift:command:control:option:)`). Escape and ⌘↩ are the host's, to stop editing
public enum CodeKeys {
  public static func name(_ key: String, shift: Bool, command: Bool, control: Bool, option: Bool) -> String {
    (shift ? "Shift-" : "") + (command ? "Meta-" : "") + (control ? "Ctrl-" : "") + (option ? "Alt-" : "") + key
  }

  public static let mac: [String: CodeCommand] = {
    var m: [String: CodeCommand] = [:]
    func both(_ k: String, _ c: (Bool) -> CodeCommand) {
      m[k] = c(false)
      m["Shift-" + k] = c(true)
    }
    for (key, forward) in [("ArrowLeft", false), ("ArrowRight", true)] {
      both(key) { .move(.character, forward: forward, extend: $0) }
      both("Alt-" + key) { .move(.group, forward: forward, extend: $0) }
      both("Meta-" + key) { .move(.lineBoundary, forward: forward, extend: $0) }
    }
    for (key, forward) in [("ArrowUp", false), ("ArrowDown", true)] {
      both(key) { .move(.line, forward: forward, extend: $0) }
      both("Meta-" + key) { .move(.document, forward: forward, extend: $0) }
      both("Ctrl-" + key) { .move(.page, forward: forward, extend: $0) }
      m["Alt-" + key] = .moveLines(down: forward)
      m["Shift-Alt-" + key] = .copyLines(down: forward)
    }
    for (key, forward) in [("PageUp", false), ("PageDown", true)] {
      both(key) { .move(.page, forward: forward, extend: $0) }
    }
    for (key, forward) in [("Home", false), ("End", true)] {
      both(key) { .move(.lineBoundary, forward: forward, extend: $0) }
      both("Meta-" + key) { .move(.document, forward: forward, extend: $0) }
    }
    // emacs's, as a Mac's text fields have them
    for (key, motion, forward) in [
      ("b", CodeEditor.Motion.character, false), ("f", .character, true), ("p", .line, false), ("n", .line, true),
      ("a", .lineStart, false), ("e", .lineStart, true),
    ] {
      both("Ctrl-" + key) { .move(motion, forward: forward, extend: $0) }
    }
    m["Ctrl-v"] = .move(.page, forward: true, extend: false)
    m["Ctrl-d"] = .deleteForward
    m["Ctrl-h"] = .deleteBackward
    m["Ctrl-k"] = .deleteToLineEnd
    m["Ctrl-Alt-h"] = .deleteGroup(forward: false)
    m["Ctrl-o"] = .splitLine
    m["Ctrl-t"] = .transpose
    m["Ctrl-l"] = .selectLine
    both("Backspace") { _ in .deleteBackward }
    m["Delete"] = .deleteForward
    m["Alt-Backspace"] = .deleteGroup(forward: false)
    m["Alt-Delete"] = .deleteGroup(forward: true)
    m["Meta-Backspace"] = .deleteLineBoundary(forward: false)
    m["Meta-Delete"] = .deleteLineBoundary(forward: true)
    // ⇧↩ as ↩: CodeMirror's falls through editor.ts's ↩ to its own, which indents by the language, and there is none
    both("Enter") { _ in .newline }
    m["Tab"] = .indent
    m["Shift-Tab"] = .outdent
    m["Meta-/"] = .toggleComment
    m["Meta-["] = .indentLess
    m["Meta-]"] = .indentMore
    m["Shift-Meta-k"] = .deleteLines
    m["Meta-a"] = .selectAll
    m["Meta-z"] = .undo
    m["Shift-Meta-z"] = .redo
    m["Meta-y"] = .redo
    return m
  }()
}

extension CodeEditor {
  /// A key's command, moving over the rows the view laid out
  public mutating func perform(_ c: CodeCommand, in layout: some CodeLayout) {
    switch c {
    case .move(let m, let forward, let extend): move(m, forward: forward, extend: extend, in: layout)
    case .deleteBackward: deleteBackward()
    case .deleteForward: deleteForward()
    case .deleteToLineEnd: deleteToLineEnd()
    case .deleteGroup(let forward): deleteGroup(forward: forward)
    case .deleteLineBoundary(let forward): deleteLineBoundary(forward: forward, in: layout)
    case .newline: newline()
    case .indent: indent()
    case .outdent: outdent()
    case .toggleComment: toggleComment()
    case .indentMore: indentMore()
    case .indentLess: indentLess()
    case .moveLines(let down): moveLines(down: down)
    case .copyLines(let down): copyLines(down: down)
    case .deleteLines: deleteLines(in: layout)
    case .selectLine: selectLine()
    case .selectAll: selectAll()
    case .splitLine: splitLine()
    case .transpose: transpose()
    case .undo: undo()
    case .redo: redo()
    }
  }
}
