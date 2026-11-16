import AppKit
import CodeBoardModel

// A collected passage on a pasteboard (dragged out of the pane), and the picture the drag shows until the board draws
// the card it will be.

extension NSPasteboard.PasteboardType {
  /// A `Collected`, as JSON
  public static let collected = NSPasteboard.PasteboardType(Collected.pasteboardType)
}

extension Collected {
  /// Its text as anything else that takes a drop reads it
  public var plainText: String {
    switch body {
    case .note(let markdown): markdown
    case .image(let alt, _, _), .picture(_, let alt, _, _): alt ?? ""
    }
  }

  /// A pasteboard item with it and its plain text
  public func pasteboardItem() -> NSPasteboardItem {
    let item = NSPasteboardItem()
    if let data = try? data() { item.setData(data, forType: .collected) }
    item.setString(plainText, forType: .string)
    return item
  }

  public func write(to pasteboard: NSPasteboard) {
    pasteboard.clearContents()
    pasteboard.writeObjects([pasteboardItem()])
  }

  /// The one on the pasteboard; nil when there is none
  public init?(from pasteboard: NSPasteboard) {
    guard let data = pasteboard.data(forType: .collected), let c = try? Collected(data: data) else { return nil }
    self = c
  }

  /// What a drag of it shows: its text on a small card, a few lines at most
  public static func dragImage(_ text: String) -> NSImage {
    let attrs: [NSAttributedString.Key: Any] = [
      .font: NSFont.systemFont(ofSize: 12), .foregroundColor: NSColor.labelColor,
    ]
    let s = NSAttributedString(string: text, attributes: attrs)
    let fit = s.boundingRect(
      with: CGSize(width: 260, height: 64), options: [.usesLineFragmentOrigin, .truncatesLastVisibleLine])
    let size = CGSize(width: ceil(fit.width) + 16, height: min(ceil(fit.height), 64) + 12)
    return NSImage(size: size, flipped: true) { r in
      NSColor.textBackgroundColor.withAlphaComponent(0.92).setFill()
      NSBezierPath(roundedRect: r, xRadius: 6, yRadius: 6).fill()
      s.draw(
        with: r.insetBy(dx: 8, dy: 6), options: [.usesLineFragmentOrigin, .truncatesLastVisibleLine])
      return true
    }
  }
}
