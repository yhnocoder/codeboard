import CodeBoardMarkdown
import CodeBoardMarkdownUI
import CoreGraphics
import Foundation

/// `MarkdownBench --editor`: what a key costs the main thread in a long Note being edited, without a window. A Note of
/// 1200 paragraphs (headings, lists, code, tables, CJK prose between them) is opened for editing in Warm Ink at 360
/// points, and 500 keys are played into it at a place in the middle: letters and spaces, an Enter (a new paragraph)
/// every 60 keys, a Backspace every 15. For each key, in the thread's CPU time: the reparse (MarkdownDocument.reparse),
/// laying out the blocks it changed, the pass over every block that matches and stacks them (restack), and drawing the
/// 800 points around the caret at 2x. Rows: typing in prose, in a list item, and on a link reference definition's line
/// (which today parses the whole Note: a label → blocks index is the next step). Prints one JSON object.
enum EditorBench {
  static func run() throws {
    let rows: [(String, String, String, Script)] = [
      ("prose", document(definitions: false), "Paragraph 601 ", .typing),
      ("list item", document(definitions: false), "list item 612 ", .typing),
      ("prose, Note with definitions", document(definitions: true), "Paragraph 601 ", .typing),
      ("definition URL", document(definitions: true), "[ref]: https://example.com/", .typing),
      ("definition made and removed", document(definitions: true), "Paragraph 601 ", .definitions),
      ("caret moves", document(definitions: false), "Paragraph 601 ", .arrows),
      ("typed through the editor core", document(definitions: false), "Paragraph 601 ", .core),
    ]
    var out: [String: Any] = [:]
    // MARKDOWN_BENCH_ROWS=name,name runs only those rows, in that order
    let only = ProcessInfo.processInfo.environment["MARKDOWN_BENCH_ROWS"]?.split(separator: ",").map(String.init)
    let chosen = only.map { names in names.compactMap { n in rows.first { $0.0 == n } } } ?? rows
    for (name, text, anchor, script) in chosen {
      out[name] = try row(text, anchor: anchor, script: script)
    }
    let json = try JSONSerialization.data(withJSONObject: out, options: [.prettyPrinted, .sortedKeys])
    print(String(decoding: json, as: UTF8.self))
  }

  /// What the keys are: typing (letters and spaces, an Enter every 60, a Backspace every 15), or a definition line put
  /// in after the paragraph and taken out again, key by key (each one a paste or a cut of it)
  /// or the caret moved by keys (→ through words and markers, ⌥→, ↓ and ↑, ⌘→), the markers following it
  /// or the typing script played through EditorCore's keys (its one apply path, undo recorded, caret placed)
  enum Script { case typing, definitions, arrows, core }

  static func document(definitions: Bool) -> String {
    var parts: [String] = []
    for i in 0..<1200 {
      switch i % 40 {
      case 0: parts.append("## Section \(i / 40 + 1)")
      case 12: parts.append("- list item \(i) with **bold**\n- another item\n  - nested")
      case 20: parts.append("```python\ndef step(batch):\n    return model(batch)  # \(i)\n```")
      case 30: parts.append("| stage | ms |\n|---|---|\n| prefill \(i) | 12.5 |")
      default:
        parts.append(
          "Paragraph \(i) with some **bold**, `code`, a [link](https://example.com) and 中文混排的一段文字，看看折行。")
      }
    }
    if definitions {
      // definitions spread through the Note, as a long Note with reference links has them
      for i in stride(from: 50, to: 1200, by: 100) { parts[i] += " See [ref \(i)][r\(i)]." }
      for i in stride(from: 99, to: 1200, by: 100) { parts.insert("[r\(i - 49)]: https://example.com/\(i)", at: i) }
      parts.append("See [the reference][ref].\n\n[ref]: https://example.com/a")
    }
    return parts.joined(separator: "\n\n")
  }

  static func row(_ text: String, anchor: String, script: Script) throws -> [String: Any] {
    try MarkdownAssets.fonts.get()
    let resources = BenchResources(math: try MarkdownAssets.engines())
    let card = MarkdownLooks.card(.note, look: "warm-ink", dark: false)
    let width = 360 - card.padding[1] - card.padding[3]
    // the Note shown (laid out for the display), then opened for editing (a copy of that layout)
    let t0 = cpu()
    let shownLayout = BlockLayout(
      MarkdownDocument(text), width: width, theme: card.theme, layout: nil, resources: resources)
    let t1 = cpu()
    let editor = shownLayout.copy(resources: resources)
    let entered = cpu() - t1
    let displayed = t1 - t0
    var doc = editor.document
    let start = (doc.source as NSString).range(of: anchor)
    precondition(start.location != NSNotFound, "no \(anchor) in the bench Note")
    var caret = NSMaxRange(start)
    let scale: CGFloat = 2
    let viewport: CGFloat = 800
    let ctx = CGContext(
      data: nil, width: Int(editor.width * scale), height: Int(viewport * scale), bitsPerComponent: 8, bytesPerRow: 0,
      space: CGColorSpace(name: CGColorSpace.sRGB)!, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
    ctx.translateBy(x: 0, y: viewport * scale)
    ctx.scaleBy(x: scale, y: -scale)
    // the Note was on screen before it was edited: what is around the caret has been drawn once already
    let shownAt = editor.blockFrames[doc.blocks.lastIndex { $0.range.lowerBound <= caret } ?? 0]
    let shown = CGRect(x: 0, y: max(0, shownAt.midY - viewport / 2), width: editor.width, height: viewport)
    ctx.saveGState()
    ctx.translateBy(x: 0, y: -shown.minY)
    editor.draw(in: ctx, scale: scale, clip: shown) { _ in nil }
    ctx.restoreGState()
    if script == .arrows { return arrows(editor, caret: caret, ctx: ctx, scale: scale, viewport: viewport) }
    if script == .core { return typed(editor, caret: caret, ctx: ctx, scale: scale, viewport: viewport) }
    let typed = Array("the scheduler keeps a batch of requests in flight ")
    var reparse: [Double] = []
    var layout: [Double] = []
    var restack: [Double] = []
    var draw: [Double] = []
    var total: [Double] = []
    var laidOut = 0
    var slow: [[String: Any]] = []
    // each key in a pool of its own, as each key event is in the app's run loop
    for key in 0..<500 {
      autoreleasepool {
        let r: Range<Int>
        let ins: String
        let definition = "\n\n[made\(key)]: https://example.com/new"
        if script == .definitions {
          if key % 2 == 0 {
            r = caret..<caret
            ins = definition
          } else {
            let made = "\n\n[made\(key - 1)]: https://example.com/new" as NSString
            r = (caret - made.length)..<caret
            ins = ""
          }
        } else if key % 15 == 14 {
          r = (caret - 1)..<caret
          ins = ""
        } else if key % 60 == 59 {
          r = caret..<caret
          ins = "\n\n"
        } else {
          r = caret..<caret
          ins = String(typed[key % typed.count])
        }
        let a = cpu()
        let next = doc.reparse(replacing: r, with: ins)
        let b = cpu()
        caret = r.lowerBound + (ins as NSString).length
        let t = editor.update(to: next, replacing: r, delta: (ins as NSString).length - r.count, head: caret)
        let c = cpu()
        // the 800 points around the caret's block
        let frames = editor.blockFrames
        let i = next.blocks.lastIndex { $0.range.lowerBound <= caret } ?? 0
        let clip = CGRect(x: 0, y: max(0, frames[i].midY - viewport / 2), width: editor.width, height: viewport)
        ctx.saveGState()
        ctx.translateBy(x: 0, y: -clip.minY)
        ctx.clear(clip)
        editor.draw(in: ctx, scale: scale, clip: clip) { _ in nil }
        ctx.restoreGState()
        let d = cpu()
        doc = next
        reparse.append(b - a)
        layout.append(t.layout)
        restack.append(t.restack)
        draw.append(d - c)
        total.append(d - a)
        laidOut += t.laidOut
        if d - a > 5 {
          slow.append([
            "key": key, "edit": ins.isEmpty ? "delete \(r.count)" : ins.debugDescription, "reparse": b - a,
            "layout": t.layout, "restack": t.restack, "draw": d - c, "laid_out": t.laidOut,
          ])
        }
      }
    }
    func stats(_ v: [Double]) -> [String: Double] {
      let s = v.sorted()
      let at = { (p: Double) in (s[Int(Double(s.count - 1) * p)] * 1000).rounded() / 1000 }
      return ["median": at(0.5), "p95": at(0.95), "max": at(1)]
    }
    return [
      "blocks": doc.blocks.count, "display_ms": (displayed * 10).rounded() / 10,
      "enter_edit_ms": (entered * 1000).rounded() / 1000, "keys": 500, "slow_keys": slow,
      "blocks_laid_out_per_key": Double(laidOut) / 500,
      "reparse_ms": stats(reparse), "layout_ms": stats(layout), "restack_ms": stats(restack), "draw_ms": stats(draw),
      "total_ms": stats(total),
    ]
  }

  /// 500 caret moves from `caret`: what moving costs (finding the place, laying out the blocks whose markers show or go,
  /// restacking) and drawing the 800 points around it
  static func arrows(_ editor: BlockLayout, caret: Int, ctx: CGContext, scale: CGFloat, viewport: CGFloat) -> [String:
    Any]
  {
    let core = EditorCore(layout: editor, caret: caret)
    var move: [Double] = []
    var draw: [Double] = []
    var total: [Double] = []
    var relaid = 0
    for key in 0..<500 {
      autoreleasepool {
        let a = cpu()
        let before = editor.head
        switch key % 20 {
        case 7: core.moveVertically(down: true, extend: false)
        case 13: core.moveVertically(down: false, extend: false)
        case 17: core.move(.word, forward: true, extend: false)
        case 19: core.move(.line, forward: true, extend: false)
        default: core.move(.character, forward: true, extend: false)
        }
        _ = core.caretRect
        let b = cpu()
        if editor.head != before { relaid += 1 }
        let r = core.caretRect ?? .zero
        let clip = CGRect(x: 0, y: max(0, r.midY - viewport / 2), width: editor.width, height: viewport)
        ctx.saveGState()
        ctx.translateBy(x: 0, y: -clip.minY)
        ctx.clear(clip)
        editor.draw(in: ctx, scale: scale, clip: clip) { _ in nil }
        ctx.restoreGState()
        let c = cpu()
        move.append(b - a)
        draw.append(c - b)
        total.append(c - a)
      }
    }
    func stats(_ v: [Double]) -> [String: Double] {
      let s = v.sorted()
      let at = { (p: Double) in (s[Int(Double(s.count - 1) * p)] * 1000).rounded() / 1000 }
      return ["median": at(0.5), "p95": at(0.95), "max": at(1)]
    }
    return ["keys": 500, "moved": relaid, "move_ms": stats(move), "draw_ms": stats(draw), "total_ms": stats(total)]
  }

  /// 500 keys of the typing script through EditorCore, and the 800 points around the caret drawn after each
  static func typed(_ editor: BlockLayout, caret: Int, ctx: CGContext, scale: CGFloat, viewport: CGFloat) -> [String:
    Any]
  {
    let core = EditorCore(layout: editor, caret: caret)
    let typed = Array("the scheduler keeps a batch of requests in flight ")
    var key: [Double] = []
    var draw: [Double] = []
    var total: [Double] = []
    for k in 0..<500 {
      autoreleasepool {
        let a = cpu()
        if k % 15 == 14 {
          core.key(.backspace)
        } else if k % 60 == 59 {
          core.key(.enter)
        } else {
          core.insert(String(typed[k % typed.count]))
        }
        let r = core.caretRect ?? .zero
        let b = cpu()
        let frames = editor.blockFrames
        let i = core.document.blocks.lastIndex { $0.range.lowerBound <= core.selection.head } ?? 0
        let clip =
          ProcessInfo.processInfo.environment["BYFRAME"] != nil
          ? CGRect(x: 0, y: max(0, frames[i].midY - viewport / 2), width: editor.width, height: viewport)
          : CGRect(x: 0, y: max(0, r.midY - viewport / 2), width: editor.width, height: viewport)
        ctx.saveGState()
        ctx.translateBy(x: 0, y: -clip.minY)
        ctx.clear(clip)
        editor.draw(in: ctx, scale: scale, clip: clip) { _ in nil }
        ctx.restoreGState()
        let c = cpu()
        key.append(b - a)
        draw.append(c - b)
        total.append(c - a)
      }
    }
    func stats(_ v: [Double]) -> [String: Double] {
      let s = v.sorted()
      let at = { (p: Double) in (s[Int(Double(s.count - 1) * p)] * 1000).rounded() / 1000 }
      return ["median": at(0.5), "p95": at(0.95), "max": at(1)]
    }
    return ["keys": 500, "key_ms": stats(key), "draw_ms": stats(draw), "total_ms": stats(total)]
  }

  static func cpu() -> Double {
    var t = timespec()
    clock_gettime(CLOCK_THREAD_CPUTIME_ID, &t)
    return Double(t.tv_sec) * 1000 + Double(t.tv_nsec) / 1e6
  }
}
