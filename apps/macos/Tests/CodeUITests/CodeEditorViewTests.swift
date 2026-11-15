import AppKit
import CodeCore
import CodeUI
import Testing

/// The editing view without a window: its methods called as AppKit and an input method call them, events made here
/// and handed to it (none goes through the system), pictures drawn offscreen
@MainActor @Suite struct CodeEditorViewTests {
  let m = CodeLineMetrics(row: 20, fold: 24, padLeft: 17, numberGap: 22, padRight: 18, charWidth: 0)

  func look() -> CodeEditorView.Look {
    let font = CodeFont(CTFontCreateWithName("Menlo" as CFString, 11, nil))
    var metrics = m
    metrics.charWidth = CodeDraw.width("0", font)
    let style = CodeStyle(
      font: font, ink: CGColor(gray: 0.1, alpha: 1),
      runs: [nil, .init(color: CGColor(red: 0.7, green: 0.2, blue: 0.1, alpha: 1))])
    return .init(
      style: style, metrics: metrics, numberColor: CGColor(gray: 0.5, alpha: 1),
      selection: CGColor(red: 0.2, green: 0.4, blue: 0.9, alpha: 0.3), currentLine: nil,
      band: CodeBandShape(left: -4, right: 14, inset: 2, radius: 6), padTop: 6, padBottom: 8)
  }

  func view(_ text: String, width: CGFloat = 400) -> CodeEditorView {
    let v = CodeEditorView(text: text, look: look())
    v.frame = CGRect(x: 0, y: 0, width: width, height: 200)
    return v
  }

  func key(_ code: UInt16, _ chars: String, _ flags: NSEvent.ModifierFlags = []) -> NSEvent {
    NSEvent.keyEvent(
      with: .keyDown, location: .zero, modifierFlags: flags, timestamp: 0, windowNumber: 0, context: nil,
      characters: chars, charactersIgnoringModifiers: chars, isARepeat: false, keyCode: code)!
  }

  func click(_ v: CodeEditorView, at p: CGPoint, count: Int, _ type: NSEvent.EventType = .leftMouseDown) -> NSEvent {
    NSEvent.mouseEvent(
      with: type, location: v.convert(p, to: nil), modifierFlags: [], timestamp: 0, windowNumber: 0, context: nil,
      eventNumber: 0, clickCount: count, pressure: 1)!
  }

  func pixels(_ v: NSView) -> Data {
    let rep = v.bitmapImageRepForCachingDisplay(in: v.bounds)!
    v.cacheDisplay(in: v.bounds, to: rep)
    return Data(bytes: rep.bitmapData!, count: rep.bytesPerRow * rep.pixelsHigh)
  }

  @Test func keysAreCodeMirrorsAndTypingComesThroughTheInputClient() {
    let v = view("def f(x):")
    var said: [String] = []
    v.onChange = { said.append($0) }
    v.keyDown(with: key(36, "\r"))
    v.insertText("return x", replacementRange: NSRange(location: NSNotFound, length: 0))
    #expect(v.editor.text == "def f(x):\n    return x")
    // ⌥⌫ a group, ⌘← to the indent's end, ⇧⌘K the line
    v.keyDown(with: key(51, "\u{7f}", .option))
    #expect(v.editor.text == "def f(x):\n    return ")
    v.keyDown(with: key(123, "", .command))
    #expect(v.editor.selection == CodeSelection(14))
    v.keyDown(with: key(40, "k", [.command, .shift]))
    #expect(v.editor.text == "def f(x):")
    #expect(said.last == "def f(x):" && said.count == 4)
    var out = false
    v.onExit = { out = true }
    v.keyDown(with: key(53, "\u{1b}"))
    #expect(out)
  }

  @Test func aCompositionIsDrawnInPlaceAndOutOfTheTextUntilCommitted() {
    let v = view("a = ")
    var said: [String] = []
    v.onChange = { said.append($0) }
    let none = NSRange(location: NSNotFound, length: 0)
    v.setMarkedText("ni", selectedRange: NSRange(location: 2, length: 0), replacementRange: none)
    v.setMarkedText("ni hao", selectedRange: NSRange(location: 6, length: 0), replacementRange: none)
    #expect(v.editor.text == "a = " && v.hasMarkedText() && said.isEmpty)
    #expect(v.markedRange() == NSRange(location: 4, length: 6) && v.selectedRange() == NSRange(location: 10, length: 0))
    #expect(
      v.attributedSubstring(forProposedRange: NSRange(location: 4, length: 6), actualRange: nil)?.string == "ni hao")
    // laid out again while composing (new colours came): the composition stays
    v.runs = [[CodeRun(columns: 0..<1, style: 1)]]
    #expect(v.hasMarkedText() && v.layout.lineRows.count == 1)
    v.insertText("你好", replacementRange: none)
    #expect(v.editor.text == "a = 你好" && !v.hasMarkedText() && said == ["a = 你好"])
    // given up: nothing written
    v.setMarkedText("x", selectedRange: NSRange(location: 1, length: 0), replacementRange: none)
    v.setMarkedText("", selectedRange: NSRange(location: 0, length: 0), replacementRange: none)
    #expect(v.editor.text == "a = 你好" && !v.hasMarkedText())
  }

  @Test func clicksPlaceSelectAWordAndALine() {
    let v = view("alpha beta\ngamma")
    let row = v.layout.lineRows[0]
    let x = v.layout.caret(7, assoc: 1).minX + 1
    let p = CGPoint(x: x, y: row.y + row.height / 2)
    v.mouseDown(with: click(v, at: p, count: 1))
    v.mouseUp(with: click(v, at: p, count: 1, .leftMouseUp))
    #expect(v.editor.selection == CodeSelection(7))
    v.mouseDown(with: click(v, at: p, count: 2))
    #expect(v.editor.selection == CodeSelection(anchor: 6, head: 10))
    v.mouseDown(with: click(v, at: p, count: 3))
    #expect(v.editor.selection == CodeSelection(anchor: 0, head: 11))
  }

  @Test func theCodeIsDrawnAsCodeDrawDrawsItWithoutEditing() {
    let text = "def f(x):\n\treturn x + 1  # one\n"
    let v = view(text)
    let l = look()
    v.runs = [[CodeRun(columns: 0..<3, style: 1)], [], []]
    // the same rows drawn by hand, as a code card's body draws them
    final class Still: NSView {
      var draw: (CGContext) -> Void = { _ in }
      override var isFlipped: Bool { true }
      override func draw(_ r: NSRect) {
        let ctx = NSGraphicsContext.current!.cgContext
        ctx.textMatrix = CGAffineTransform(scaleX: 1, y: -1)
        draw(ctx)
      }
    }
    let still = Still(frame: v.frame)
    let lines = CodeLines(
      lines: text.components(separatedBy: "\n"), runs: v.runs, top: l.padTop, metrics: l.metrics)
    let gutter = CodeLines.gutter(lastNumber: 3, metrics: l.metrics)
    still.draw = { ctx in
      for r in lines.rows {
        guard case .line(let n, _, let s, let runs) = r.kind else { continue }
        let mid = r.y + r.height / 2
        CodeDraw.number(
          n, in: ctx, right: gutter - l.metrics.numberGap, midY: mid, font: l.style.font, color: l.numberColor)
        CodeDraw.line(s, runs: runs, in: ctx, x: gutter, midY: mid, style: l.style)
      }
    }
    #expect(pixels(v) == pixels(still))
    #expect(v.height == lines.bottom + l.padBottom)
  }

  @Test func offsetsAndPlacesThroughTabsAndWrappedRows() {
    let l = look()
    let cw = l.metrics.charWidth
    let t = CodeTextLayout(text: "a\tb", x: 10, metrics: l.metrics, style: l.style)
    #expect(abs(t.x(of: 2, assoc: 1) - t.x(of: 1, assoc: 1) - 4 * cw) < 0.01)
    // in the tab: the nearer side
    #expect(t.offset(inRow: 0, x: t.x(of: 1, assoc: 1) + 1.5 * cw) == 1)
    #expect(t.offset(inRow: 0, x: t.x(of: 1, assoc: 1) + 2.5 * cw) == 2)
    // cut at four columns: the wrap point is the end of the first row and the start of the second
    let w = CodeTextLayout(text: "abcdefg\nh", wrapColumns: 4, x: 0, metrics: l.metrics, style: l.style)
    #expect(w.rowCount == 3 && w.offsets(inRow: 0) == 0...4 && w.offsets(inRow: 1) == 4...7)
    #expect(w.row(of: 4, assoc: -1) == 0 && w.row(of: 4, assoc: 1) == 1 && w.row(of: 8, assoc: 1) == 2)
    #expect(w.rects(1..<6, right: 300).count == 2 && w.rects(1..<6, right: 300)[0].maxX == 300)
    // ↓ from the first row goes to the second, not the next line
    var e = CodeEditor(text: "abcdefg\nh", selection: CodeSelection(1))
    e.move(.line, forward: true, extend: false, in: w)
    #expect(e.selection == CodeSelection(5))
  }

  @Test func zoomingScalesWithoutLayingOutAgain() {
    let v = view("a long line of code that wraps at the width of the view", width: 200)
    v.wrap = true
    let rows = v.layout.lineRows
    #expect(rows.count > 1)
    var heights: [CGFloat] = []
    v.onHeight = { heights.append($0) }
    v.place(CGRect(x: 10, y: 20, width: 400, height: 400), zoom: 2)
    #expect(v.bounds.size == CGSize(width: 200, height: 200) && v.layout.lineRows == rows && heights.isEmpty)
    // narrower in its own units: cut again
    v.place(CGRect(x: 10, y: 20, width: 300, height: 400), zoom: 2)
    #expect(v.layout.lineRows.count > rows.count && heights.count == 1)
  }
}
