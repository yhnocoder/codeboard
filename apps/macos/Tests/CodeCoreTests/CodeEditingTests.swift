import Testing

@testable import CodeCore

/// The code rules on a text alone (cm/editor.ts): Enter, Tab, ⇧Tab and ⌘/
@Suite struct CodeEditingTests {
  @Test func enterKeepsTheIndentAndDeepensAfterAnOpener() {
    let e = CodeEditing.newline(in: "def f():\n  x", selection: CodeSelection(8))
    #expect(e.applied(to: "def f():\n  x") == "def f():\n    \n  x" && e.selection == CodeSelection(13))
    #expect(e.undo == .typing)
    #expect(
      CodeEditing.newline(in: "\t  y = [", selection: CodeSelection(8), opens: "").applied(to: "\t  y = [")
        == "\t  y = [\n\t  ")
    // only what is before the caret counts, and the indent up to it
    #expect(CodeEditing.newline(in: "f(a)", selection: CodeSelection(2)).applied(to: "f(a)") == "f(\n    a)")
    #expect(CodeEditing.newline(in: "    ab", selection: CodeSelection(2)).applied(to: "    ab") == "  \n    ab")
  }

  @Test func tabAndShiftTab() {
    let one = CodeEditing.indent(in: "ab", selection: CodeSelection(anchor: 1, head: 2))
    #expect(one.applied(to: "ab") == "a    " && one.selection == CodeSelection(5) && one.undo == .typing)
    let text = "x\n\n\ty\n      z"
    let more = CodeEditing.indent(in: text, selection: CodeSelection(anchor: 0, head: 5))
    #expect(
      more.applied(to: text) == "    x\n\n    \ty\n      z" && more.selection == CodeSelection(anchor: 4, head: 13))
    #expect(more.undo == .command)
    let back = CodeEditing.outdent(in: text, selection: CodeSelection(anchor: 3, head: 11))
    #expect(back.applied(to: text) == "x\n\ny\n  z" && back.selection == CodeSelection(anchor: 3, head: 6))
    // a caret: its line
    #expect(CodeEditing.outdent(in: "  a\n  b", selection: CodeSelection(5)).applied(to: "  a\n  b") == "  a\nb")
  }

  @Test func commentsAtTheLeastIndentAndBack() {
    let text = "  if x:\n\n      y()"
    let on = CodeEditing.toggleComment(in: text, selection: CodeSelection(anchor: 3, head: 12), mark: "#")
    let commented = on.applied(to: text)
    #expect(commented == "  # if x:\n\n  #     y()" && on.undo == .command)
    let off = CodeEditing.toggleComment(
      in: commented, selection: CodeSelection(anchor: 0, head: (commented as String).utf16.count), mark: "#")
    #expect(off.applied(to: commented) == text)
    // one line not commented: all are
    #expect(
      CodeEditing.toggleComment(in: "// a\nb", selection: CodeSelection(anchor: 0, head: 6), mark: "//").applied(
        to: "// a\nb") == "// // a\n// b")
    #expect(CodeEditing.lineComment(language: "Python") == "#" && CodeEditing.lineComment(language: "lua") == "--")
    #expect(CodeEditing.lineComment(language: nil) == "//")
    #expect(["triton", "ini", "txt"].map { CodeEditing.lineComment(language: $0) } == ["#", ";", "#"])
  }
}
