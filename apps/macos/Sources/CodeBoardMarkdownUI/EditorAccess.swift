import AppKit
import CodeBoardMarkdown

/// What the editor tells assistive technology and a driver: a text area whose value is the Markdown, with its selection
/// and the caret's line; and the pointer's shape at a point
extension MarkdownEditorView {
  public override func isAccessibilityElement() -> Bool { true }
  public override func accessibilityRole() -> NSAccessibility.Role? { .textArea }
  public override func accessibilityRoleDescription() -> String? { "Markdown" }
  public override func accessibilityValue() -> Any? { core.source }
  public override func accessibilityNumberOfCharacters() -> Int { (core.source as NSString).length }
  public override func accessibilitySelectedTextRange() -> NSRange {
    let r = core.selection.range
    return NSRange(location: r.lowerBound, length: r.count)
  }
  public override func accessibilitySelectedText() -> String? {
    let r = core.selection.range
    return (core.source as NSString).substring(with: NSRange(location: r.lowerBound, length: r.count))
  }
  public override func accessibilityFrame(for range: NSRange) -> NSRect {
    firstRect(forCharacterRange: range, actualRange: nil)
  }

  /// The pointer's shape at a point (the view's points) with these modifiers: the resize arrows over a table's column
  /// and row edges and an image's handles, an open hand over a table grip, a pointing hand over a link's words (its
  /// markers written out too with ⌘ held) and over a drawn atom other than a picture, the I-beam over text while
  /// editing; on the static picture the arrow, a pointing hand over a link and a [[reference]] that finds its card
  public func cursor(at p: CGPoint, modifiers: NSEvent.ModifierFlags = []) -> NSCursor {
    let at = CGPoint(x: p.x / zoom, y: p.y / zoom)
    // the board's .md-link and .md-ref take the pointer; a reference that finds nothing does nothing there
    // (.md-ref.missing:not(.md-atom))
    guard isEditing else { return link(at: at) != nil || ref(at: at)?.found == true ? .pointingHand : .arrow }
    // a selected image's width grips on its sides (markdown.css .md-imgrip: ew-resize)
    if let box = imageBox, handles(box).contains(where: { $0.insetBy(dx: -4, dy: -4).contains(at) }) {
      return .resizeLeftRight
    }
    if let k = tableCursor(at) { return k }
    // a click there opens the link's box or acts on the atom (.md-link, .md-urlchip, .md-pm .md-atom: cursor pointer)
    if link(at: at)?.hand == true || handAtom(at) { return .pointingHand }
    if modifiers.contains(.command), linkUnder(at) { return .pointingHand }
    return .iBeam
  }

  /// The link drawn under a point (the layout's points): its source, its address, and whether the point is on what a
  /// click takes as the link, its words or its address folded to its site, rather than on its markers written out
  func link(at: CGPoint) -> (range: Range<Int>, url: String, hand: Bool)? {
    let q = core.layout.caret(at: at).offset
    guard let run = MarkdownEditing.run(at: q, in: core.document), run.kind == .inline else { return nil }
    func all(_ ins: [MDInline]) -> [MDInline] { ins.flatMap { [$0] + all($0.children) } }
    // the nearest caret is found past a line's end too: the point must be on the link's own boxes
    let under = { (r: Range<Int>) in self.core.rects(for: r).contains { $0.contains(at) } }
    for i in all(run.inlines) {
      let url: String
      switch i.kind {
      case .link(let u), .autolink(let u): url = u
      default: continue
      }
      guard i.range.lowerBound <= q, q <= i.range.upperBound, under(i.range) else { continue }
      guard let h = core.layout.head, i.range.lowerBound <= h, h <= i.range.upperBound else {
        return (i.range, url, true)
      }
      let address = MarkdownEditing.linkAddress(i, in: core.document)
      let folded = address.map { !($0.lowerBound <= h && h <= $0.upperBound) } ?? false
      return (i.range, url, under(i.inner ?? i.range) || (folded && address.map(under) == true))
    }
    return nil
  }

  /// the drawn [[reference]] under a point: its source and whether it finds its card
  func ref(at: CGPoint) -> (range: Range<Int>, found: Bool)? {
    guard let r = core.layout.atom(at: at), let i = MarkdownEditing.inline(r, in: core.document),
      case .atom(.ref(let label, let target)) = i.kind
    else { return nil }
    if case .found = core.layout.resources.ref(label: label, target: target) { return (r, true) }
    return (r, false)
  }

  /// a drawn atom a click acts on: a formula, a reference, an emoji, HTML (widgets.ts md-atom; a picture is its own)
  private func handAtom(_ at: CGPoint) -> Bool {
    guard let r = core.layout.atom(at: at), let i = MarkdownEditing.inline(r, in: core.document),
      case .atom(let a) = i.kind
    else { return false }
    switch a {
    case .image, .lineBreak, .annotation: return false
    case .math, .emoji, .ref, .html: return true
    }
  }

  /// The tips of the static picture, found again when its layout changed: a link's whole address (ui/Md.tsx: a link's
  /// data-tip, data-tip-long), and on a [[reference]] that finds nothing why (view.ts paintRef's title), each over its
  /// boxes, about the whole link or reference
  func refreshTips() {
    let key = TipsKey(layout: ObjectIdentifier(core.layout), revision: core.revision, zoom: zoom, editing: isEditing)
    guard key != tipsKey else { return }
    tipsKey = key
    tips = []
    guard !isEditing else { return }
    let doc = core.document
    func walk(_ ins: [MDInline]) {
      for i in ins {
        switch i.kind {
        case .link(let url), .autolink(let url):
          let boxes = core.rects(for: i.range)
          guard let first = boxes.first else { break }
          let whole = boxes.dropFirst().reduce(first) { $0.union($1) }
          for r in boxes { tips.append((url, r, whole, true)) }
        case .atom(.ref(let label, let target)):
          if case .found = core.layout.resources.ref(label: label, target: target) { break }
          if let r = core.layout.rects(forAtom: i.range) { tips.append((Self.nothingFound, r, r, false)) }
        default: break
        }
        walk(i.children)
      }
    }
    for b in doc.blocks {
      for run in MarkdownEditing.runs(of: b, in: doc) where run.kind == .inline { walk(run.inlines) }
    }
  }

  /// the tip of the static picture at a point (the layout's points)
  func tip(at: CGPoint) -> (text: String, box: CGRect, whole: CGRect, long: Bool)? {
    tips.first { $0.box.insetBy(dx: -0.5, dy: -0.5).contains(at) }
  }

  /// what a reference that finds nothing says (view.ts MISSING)
  static let nothingFound = "Nothing with this title"
}

/// what the tips were last found for
struct TipsKey: Equatable {
  var layout: ObjectIdentifier
  var revision: Int
  var zoom: CGFloat
  var editing: Bool
}
