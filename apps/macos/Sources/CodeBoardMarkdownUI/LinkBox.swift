import AppKit
import CodeBoardMarkdown

/// The link box (editor/bubble.tsx, links.ts): under a link (or the selection a new one goes on), its text and its address,
/// Open and Remove. ↵ writes it, Esc closes it writing nothing, and so does closing it with nothing changed. At the
/// screen's own size
@MainActor
final class LinkBox: NSView, NSTextFieldDelegate {
  let text = NSTextField()
  let url = NSTextField()
  /// Open and Remove Link, text buttons in a row under the fields (bubble.tsx md-linkacts)
  let acts = LinkActs()
  var place: MDLinkPlace?
  var onWrite: (MDLinkPlace, String, String) -> Void = { _, _, _ in }
  var onOpen: (String) -> Void = { _ in }
  var onClose: () -> Void = {}

  override init(frame: NSRect) {
    super.init(frame: CGRect(x: 0, y: 0, width: 320, height: 92))
    wantsLayer = true
    layer?.cornerRadius = 8
    layer?.borderWidth = 1
    for (f, p) in [(text, "Text"), (url, "Address")] {
      f.placeholderString = p
      f.bezelStyle = .roundedBezel
      f.font = .systemFont(ofSize: 12)
      f.delegate = self
      addSubview(f)
    }
    addSubview(acts)
    acts.onPress = { [weak self] id in
      if id == "open" { self?.openLink() } else { self?.removeLink() }
    }
    isHidden = true
  }

  @available(*, unavailable)
  required init?(coder: NSCoder) { fatalError() }

  override var isFlipped: Bool { true }

  override func layout() {
    super.layout()
    text.frame = CGRect(x: 10, y: 10, width: 300, height: 24)
    url.frame = CGRect(x: 10, y: 40, width: 300, height: 24)
    acts.frame = CGRect(x: 8, y: 68, width: 304, height: 26)
  }

  /// a new look or appearance while shown
  func restyle(_ theme: MarkdownTheme) {
    layer?.backgroundColor = theme.colors.surface.cg
    layer?.borderColor = theme.colors.hair.cg
  }

  func show(_ p: MDLinkPlace, under r: CGRect, theme: MarkdownTheme) {
    place = p
    text.stringValue = p.text
    url.stringValue = p.url
    layer?.backgroundColor = theme.colors.surface.cg
    layer?.borderColor = theme.colors.hair.cg
    // under the link, from its start, kept inside the Note's width where it fits (place.ts bottom-start, shifted)
    let w: CGFloat = 320
    let room = superview?.bounds.width ?? w
    frame = CGRect(x: max(0, min(r.minX, room - w)), y: r.maxY + 6, width: w, height: 100)
    isHidden = false
    acts.theme = theme
    acts.removes = p.exists
    window?.makeFirstResponder(p.exists || p.text.isEmpty == false ? url : text)
  }

  func close() {
    guard !isHidden else { return }
    isHidden = true
    place = nil
    onClose()
  }

  private func openLink() {
    let u = url.stringValue.trimmingCharacters(in: .whitespaces)
    if !u.isEmpty { onOpen(u) }
  }

  private func removeLink() {
    guard let p = place else { return }
    onWrite(p, text.stringValue, "")
    close()
  }

  func control(_ control: NSControl, textView: NSTextView, doCommandBy sel: Selector) -> Bool {
    if sel == #selector(NSResponder.insertNewline(_:)) {
      if let p = place { onWrite(p, text.stringValue, url.stringValue) }
      close()
      return true
    }
    if sel == #selector(NSResponder.cancelOperation(_:)) {
      close()
      return true
    }
    return false
  }
}

/// The link box's two text buttons (.md-linkacts .md-linkbtn: 24 high, 8 points of padding, 12-point text), the web page's
/// buttons (.tbtn): the ink at 7 % behind and the text in the ink on hover, 12 % and a little smaller while pressed,
/// all at once (.tbtn has no transition); a click acts
@MainActor
final class LinkActs: HoverControls {
  var theme: MarkdownTheme? { didSet { needsDisplay = true } }
  /// whether Remove Link shows (a link that exists)
  var removes = true { didSet { needsDisplay = true } }
  var onPress: (String) -> Void = { _ in }
  override var isFlipped: Bool { true }
  private let font = NSFont.systemFont(ofSize: 12)
  override var pressInk: Double? { 0.12 }
  override func activate(_ id: String, box: CGRect) { onPress(id) }

  override func controls() -> [(id: String, box: CGRect, tip: String)] {
    var x: CGFloat = 0
    var out: [(id: String, box: CGRect, tip: String)] = []
    for (id, title) in [("open", "Open"), ("remove", "Remove Link")] where id == "open" || removes {
      let w = ceil((title as NSString).size(withAttributes: [.font: font]).width) + 16
      out.append((id, CGRect(x: x, y: 1, width: w, height: 24), ""))
      x += w + 2
    }
    return out
  }

  override func draw(_ dirtyRect: NSRect) {
    guard let theme, let ctx = NSGraphicsContext.current?.cgContext else { return }
    let k = CGFloat(theme.controls.buttonRadius)
    for c in controls() {
      let look = look(c.id)
      scaled(look.scale, about: c.box, ctx) {
        if look.ink > 0 {
          ctx.addPath(CGPath(roundedRect: c.box, cornerWidth: k, cornerHeight: k, transform: nil))
          ctx.setFillColor(theme.colors.ink.alpha(look.ink).cg)
          ctx.fillPath()
        }
        let title = c.id == "open" ? "Open" : "Remove Link"
        let a: [NSAttributedString.Key: Any] = [
          .font: font,
          .foregroundColor: NSColor(cgColor: theme.colors.ink2.mixed(theme.colors.ink, look.hover).cg) ?? .labelColor,
        ]
        let sz = (title as NSString).size(withAttributes: a)
        (title as NSString).draw(at: CGPoint(x: c.box.minX + 8, y: c.box.midY - sz.height / 2), withAttributes: a)
      }
    }
  }
}
