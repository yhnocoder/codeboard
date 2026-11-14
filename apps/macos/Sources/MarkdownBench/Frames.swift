import AppKit
import CodeBoardMarkdown
import CodeBoardMarkdownUI

/// `MarkdownBench --frames <script.json> --out <folder>`: plays a scripted input sequence into the editor without a window
/// and writes the editor's picture after each step as frame-001.png, frame-002.png… (2x), and steps.json with what each
/// step was, the selection after it and the main thread's time it took. For acceptance evidence beside the web's frames
/// of the same script. The script: {"text": "...", "width": 360, "look": "warm-ink", "dark": false, "steps": [...]},
/// each step one of {"type": "abc"} (each character a key), {"key": "enter|backspace|delete|tab|shiftEnter"},
/// {"move": "left|right|up|down|wordLeft|wordRight|lineStart|lineEnd", "extend": bool}, {"select": [anchor, head]},
/// {"command": "bold|italic|code|highlight|strike|h1…h6|body"}, {"marked": "pinyin"}, {"commit": "中"}, {"undo": true},
/// {"redo": true}, {"click": offset} (where the caret would be drawn), {"edit": bool}
@MainActor
enum Frames {
  struct Script: Decodable {
    var text: String
    var width: Double?
    var look: String?
    var dark: Bool?
    var steps: [Step]
  }
  struct Step: Decodable {
    var type: String?
    var key: String?
    var move: String?
    var extend: Bool?
    var select: [Int]?
    var command: String?
    var marked: String?
    var commit: String?
    var undo: Bool?
    var redo: Bool?
    var click: Int?
    var edit: Bool?
  }

  static func run(_ script: URL, out: URL) throws {
    let s = try JSONDecoder().decode(Script.self, from: Data(contentsOf: script))
    try FileManager.default.createDirectory(at: out, withIntermediateDirectories: true)
    try MarkdownAssets.fonts.get()
    let resources = BenchResources(math: try MarkdownAssets.engines())
    let card = MarkdownLooks.card(.note, look: s.look ?? "warm-ink", dark: s.dark ?? false)
    let width = CGFloat(s.width ?? 360) - card.padding[1] - card.padding[3]
    let layout = BlockLayout(
      MarkdownDocument(s.text), width: width, theme: card.theme, layout: nil, resources: resources)
    let v = MarkdownEditorView(layout: layout, caret: 0)
    v.alwaysShowsCaret = true
    v.caretColor = NSColor(cgColor: card.theme.colors.accent.cg) ?? .controlAccentColor
    v.selectionColor = NSColor(cgColor: card.theme.colors.accent.alpha(0.26).cg) ?? .selectedTextBackgroundColor
    var log: [[String: Any]] = []
    try frame(v, card, 0, out)
    for (i, step) in s.steps.enumerated() {
      let t = cpu()
      let did = play(step, v)
      let ms = cpu() - t
      try frame(v, card, i + 1, out)
      log.append([
        "step": i + 1, "did": did, "anchor": v.selection.anchor, "head": v.selection.head,
        "ms": (ms * 1000).rounded() / 1000,
      ])
    }
    try JSONSerialization.data(withJSONObject: log, options: [.prettyPrinted]).write(
      to: out.appending(path: "steps.json"))
    try v.core.source.write(to: out.appending(path: "final.md"), atomically: true, encoding: .utf8)
  }

  static func play(_ s: Step, _ v: MarkdownEditorView) -> String {
    let c = v.core
    if let t = s.type {
      for ch in t { v.insertText(String(ch), replacementRange: NSRange(location: NSNotFound, length: 0)) }
      return "type \(t)"
    }
    if let k = s.key {
      let sel: Selector? =
        switch k {
        case "enter": #selector(NSResponder.insertNewline(_:))
        case "backspace": #selector(NSResponder.deleteBackward(_:))
        case "delete": #selector(NSResponder.deleteForward(_:))
        case "tab": #selector(NSResponder.insertTab(_:))
        case "shiftEnter": #selector(NSResponder.insertLineBreak(_:))
        default: nil
        }
      if let sel { v.doCommand(by: sel) }
      return "key \(k)"
    }
    if let m = s.move {
      let x = s.extend ?? false
      switch m {
      case "left": c.move(.character, forward: false, extend: x)
      case "right": c.move(.character, forward: true, extend: x)
      case "wordLeft": c.move(.word, forward: false, extend: x)
      case "wordRight": c.move(.word, forward: true, extend: x)
      case "lineStart": c.move(.line, forward: false, extend: x)
      case "lineEnd": c.move(.line, forward: true, extend: x)
      case "up": c.moveVertically(down: false, extend: x)
      case "down": c.moveVertically(down: true, extend: x)
      default: break
      }
      return "move \(m)"
    }
    if let r = s.select, r.count == 2 {
      v.selection = MDSelection(anchor: r[0], head: r[1])
      return "select \(r[0])…\(r[1])"
    }
    if let cmd = s.command {
      let m: MDCommand? =
        switch cmd {
        case "bold": .toggle(.strong)
        case "italic": .toggle(.emphasis)
        case "code": .toggle(.code)
        case "highlight": .toggle(.highlight)
        case "strike": .toggle(.strike)
        case "body": .heading(0)
        default: cmd.hasPrefix("h") ? Int(cmd.dropFirst()).map { .heading($0) } : nil
        }
      if let m { c.command(m) }
      return "command \(cmd)"
    }
    if let m = s.marked {
      v.setMarkedText(
        m, selectedRange: NSRange(location: (m as NSString).length, length: 0),
        replacementRange: NSRange(location: NSNotFound, length: 0))
      return "marked \(m)"
    }
    if let t = s.commit {
      v.insertText(t, replacementRange: NSRange(location: NSNotFound, length: 0))
      return "commit \(t)"
    }
    if s.undo == true {
      v.undo(nil)
      return "undo"
    }
    if s.redo == true {
      v.redo(nil)
      return "redo"
    }
    if let q = s.click, let r = c.layout.caretRect(MDCaret(q)) {
      c.mouseDown(at: CGPoint(x: r.minX + 0.5, y: r.midY), clicks: 1, extend: false)
      c.mouseUp()
      c.settle()
      return "click \(q)"
    }
    if let e = s.edit {
      v.isEditing = e
      return e ? "edit" : "display"
    }
    return "nothing"
  }

  /// the editor's picture on its card's paper, 2x
  static func frame(_ v: MarkdownEditorView, _ card: MarkdownLooks.Card, _ n: Int, _ out: URL) throws {
    let size = CGSize(
      width: v.core.layout.size.width + card.padding[1] + card.padding[3], height: v.core.layout.size.height + 24)
    let scale: CGFloat = 2
    let ctx = CGContext(
      data: nil, width: Int(size.width * scale), height: Int(size.height * scale), bitsPerComponent: 8, bytesPerRow: 0,
      space: CGColorSpace(name: CGColorSpace.sRGB)!, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
    ctx.setFillColor(card.theme.colors.surface.cg)
    ctx.fill(CGRect(x: 0, y: 0, width: ctx.width, height: ctx.height))
    ctx.translateBy(x: 0, y: CGFloat(ctx.height))
    ctx.scaleBy(x: scale, y: -scale)
    ctx.translateBy(x: card.padding[3], y: 12)
    NSGraphicsContext.current = NSGraphicsContext(cgContext: ctx, flipped: true)
    v.draw(CGRect(origin: .zero, size: v.core.layout.size))
    NSGraphicsContext.current = nil
    let url = out.appending(path: String(format: "frame-%03d.png", n))
    let dest = CGImageDestinationCreateWithURL(url as CFURL, "public.png" as CFString, 1, nil)!
    CGImageDestinationAddImage(dest, ctx.makeImage()!, nil)
    CGImageDestinationFinalize(dest)
  }

  static func cpu() -> Double {
    var t = timespec()
    clock_gettime(CLOCK_THREAD_CPUTIME_ID, &t)
    return Double(t.tv_sec) * 1000 + Double(t.tv_nsec) / 1e6
  }
}
