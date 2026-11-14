import CodeBoardMarkdown
import CodeBoardMarkdownUI
import CodeBoardModel
import CodeBoardNotes
import CoreGraphics
import Foundation

/// `CanvasBench --editor`: what a key costs the main thread in a long Note being edited, without a window. A Note of
/// 1200 paragraphs (headings, lists, code, tables, CJK prose between them) is opened for editing in Warm Ink at 360
/// points, and 500 keys are played into it at a place in the middle: letters and spaces, an Enter (a new paragraph)
/// every 60 keys, a Backspace every 15. For each key, in the thread's CPU time: the reparse (MarkdownDocument.reparse),
/// laying out the blocks it changed, the pass over every block that matches and stacks them (restack), and drawing the
/// 800 points around the caret at 2x. Rows: typing in prose, in a list item, and on a link reference definition's line
/// (which today parses the whole Note: a label → blocks index is the next step). Prints one JSON object.
enum EditorBench {
  static func run() throws {
    let rows: [(String, String, String)] = [
      ("prose", document(definitions: false), "Paragraph 601 "),
      ("list item", document(definitions: false), "list item 612 "),
      ("definition line", document(definitions: true), "[ref]: https://example.com/"),
    ]
    var out: [String: Any] = [:]
    for (name, text, anchor) in rows {
      out[name] = try row(text, anchor: anchor)
    }
    let json = try JSONSerialization.data(withJSONObject: out, options: [.prettyPrinted, .sortedKeys])
    print(String(decoding: json, as: UTF8.self))
  }

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
    if definitions { parts.append("See [the reference][ref].\n\n[ref]: https://example.com/a") }
    return parts.joined(separator: "\n\n")
  }

  static func row(_ text: String, anchor: String) throws -> [String: Any] {
    let env = NoteEnv(folder: URL(filePath: "/nonexistent"))
    let note = Note(text: text, style: .note)
    let t0 = cpu()
    let (editor, _) = try NativeNotes.editor(note, width: 360, look: "warm-ink", dark: false, env: env)
    let opened = cpu() - t0
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
    let typed = Array("the scheduler keeps a batch of requests in flight ")
    var reparse: [Double] = []
    var layout: [Double] = []
    var restack: [Double] = []
    var draw: [Double] = []
    var total: [Double] = []
    var laidOut = 0
    for key in 0..<500 {
      let r: Range<Int>
      let ins: String
      if key % 15 == 14 {
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
      let t = editor.update(to: next, replacing: r, delta: (ins as NSString).length - r.count)
      let c = cpu()
      caret = r.lowerBound + (ins as NSString).length
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
    }
    func stats(_ v: [Double]) -> [String: Double] {
      let s = v.sorted()
      let at = { (p: Double) in (s[Int(Double(s.count - 1) * p)] * 1000).rounded() / 1000 }
      return ["median": at(0.5), "p95": at(0.95), "max": at(1)]
    }
    return [
      "blocks": doc.blocks.count, "open_ms": (opened * 10).rounded() / 10, "keys": 500,
      "blocks_laid_out_per_key": Double(laidOut) / 500,
      "reparse_ms": stats(reparse), "layout_ms": stats(layout), "restack_ms": stats(restack), "draw_ms": stats(draw),
      "total_ms": stats(total),
    ]
  }

  static func cpu() -> Double {
    var t = timespec()
    clock_gettime(CLOCK_THREAD_CPUTIME_ID, &t)
    return Double(t.tv_sec) * 1000 + Double(t.tv_nsec) / 1e6
  }
}
