import AppKit
import CodeBoardMarkdown

/// The link box (editor/bubble.tsx, links.ts): under a link (or the selection a new one goes on), its text and its address,
/// Open and Remove. ↵ writes it, Esc closes it writing nothing, and so does closing it with nothing changed. At the
/// screen's own size
@MainActor
final class LinkBox: NSView, NSTextFieldDelegate {
  let text = NSTextField()
  let url = NSTextField()
  private let open = NSButton()
  private let remove = NSButton()
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
    open.image = NSImage(systemSymbolName: "arrow.up.right.square", accessibilityDescription: "Open")
    open.toolTip = "Open"
    remove.image = NSImage(systemSymbolName: "link.badge.minus", accessibilityDescription: "Remove Link")
    remove.toolTip = "Remove Link"
    for b in [open, remove] {
      b.bezelStyle = .accessoryBarAction
      b.isBordered = false
      b.target = self
      addSubview(b)
    }
    open.action = #selector(openLink)
    remove.action = #selector(removeLink)
    isHidden = true
  }

  @available(*, unavailable)
  required init?(coder: NSCoder) { fatalError() }

  override var isFlipped: Bool { true }

  override func layout() {
    super.layout()
    text.frame = CGRect(x: 10, y: 10, width: 300, height: 24)
    url.frame = CGRect(x: 10, y: 40, width: 244, height: 24)
    open.frame = CGRect(x: 258, y: 40, width: 24, height: 24)
    remove.frame = CGRect(x: 286, y: 40, width: 24, height: 24)
  }

  func show(_ p: MDLinkPlace, under r: CGRect, theme: MarkdownTheme) {
    place = p
    text.stringValue = p.text
    url.stringValue = p.url
    layer?.backgroundColor = theme.colors.surface.cg
    layer?.borderColor = theme.colors.hair.cg
    frame = CGRect(x: r.minX, y: r.maxY + 6, width: 320, height: 74)
    isHidden = false
    remove.isHidden = !p.exists
    window?.makeFirstResponder(p.exists || p.text.isEmpty == false ? url : text)
  }

  func close() {
    guard !isHidden else { return }
    isHidden = true
    place = nil
    onClose()
  }

  @objc private func openLink() {
    let u = url.stringValue.trimmingCharacters(in: .whitespaces)
    if !u.isEmpty { onOpen(u) }
  }

  @objc private func removeLink() {
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
