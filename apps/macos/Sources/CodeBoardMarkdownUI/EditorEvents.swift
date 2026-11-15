import CodeBoardMarkdown
import Foundation

/// What the editor received and what it did, for a host's inspector or a test driver (MarkdownEditorView.observer).
/// Built only while someone observes; nothing here is logged anywhere by the component itself
public enum EditorEvent: Sendable {
  public enum Mouse: String, Sendable { case down, drag, up }
  case mouse(Mouse, clicks: Int, modifiers: String, offset: Int)
  /// a key or a command, and what it was taken as
  case key(String, did: String)
  /// the source edited: where, what was there, what is there now, and how it joins the undo history
  case edit(range: Range<Int>, before: String, after: String, undo: MDUndoKind)
  case undo, redo
  /// an input method's marked text, its commit, or its giving up
  case marked(String)
  case commit(String)
  case unmark
  case editing(Bool)
  /// the caret's markers shown (the offset) or hidden (nil), and why
  case reveal(Int?, reason: String)
  /// what the editor put on the pasteboard (per type) or read from it, and the rule it applied
  case copied([(type: String, text: String)])
  case pasted(String, rule: String)
}

extension EditorEvent {
  /// One line for a log
  public var line: String {
    func clip(_ s: String) -> String {
      let one = s.replacingOccurrences(of: "\n", with: "⏎")
      return one.count > 24 ? String(one.prefix(24)) + "…" : one
    }
    switch self {
    case .mouse(let m, let clicks, let mods, let at): return "mouse \(m.rawValue) ×\(clicks) \(mods)@\(at)"
    case .key(let k, let did): return "\(k) → \(did)"
    case .edit(let r, let before, let after, let undo):
      return "edit \(r.lowerBound)..<\(r.upperBound) \"\(clip(before))\" → \"\(clip(after))\" (\(undo))"
    case .undo: return "undo"
    case .redo: return "redo"
    case .marked(let t): return "marked \"\(clip(t))\""
    case .commit(let t): return "commit \"\(clip(t))\""
    case .unmark: return "marked text given up"
    case .editing(let on): return on ? "enter editing" : "leave editing"
    case .reveal(let at, let why): return at.map { "reveal at \($0) (\(why))" } ?? "markers hidden (\(why))"
    case .copied(let types):
      return "copied " + types.map { "\($0.type) \($0.text.utf16.count)" }.joined(separator: ", ")
    case .pasted(let t, let rule): return "pasted \"\(clip(t))\" (\(rule))"
    }
  }
}
