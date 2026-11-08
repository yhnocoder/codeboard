// The question popover (the board's question sticker popover): the question's Markdown and whether it is answered, written when
// the popover closes. A plain text view here; the board's TipTap editor is not worth a web view for a line or two
import AppKit

final class QuestionPopover: NSObject, NSPopoverDelegate {
  private let popover = NSPopover()
  private let text = NSTextView()
  private let answered = NSButton(checkboxWithTitle: "Answered", target: nil, action: nil)
  /** The text and state as left when the popover closed */
  var onClose: ((String, Bool) -> Void)?

  init(md: String, done: Bool) {
    super.init()
    let vc = NSViewController()
    let root = NSView(frame: NSRect(x: 0, y: 0, width: 300, height: 150))
    let scroll = NSScrollView(frame: NSRect(x: 12, y: 40, width: 276, height: 98))
    scroll.hasVerticalScroller = true
    scroll.borderType = .noBorder
    scroll.drawsBackground = false
    text.frame = scroll.bounds
    text.isRichText = false
    text.font = NSFont.systemFont(ofSize: 13)
    text.string = md
    text.drawsBackground = false
    text.isVerticallyResizable = true
    text.autoresizingMask = [.width]
    text.textContainer?.widthTracksTextView = true
    scroll.documentView = text
    answered.frame = NSRect(x: 12, y: 10, width: 120, height: 20)
    answered.state = done ? .on : .off
    root.addSubview(scroll)
    root.addSubview(answered)
    vc.view = root
    popover.contentViewController = vc
    popover.behavior = .transient
    popover.delegate = self
  }
  func show(relativeTo rect: CGRect, of view: NSView) {
    popover.show(relativeTo: rect, of: view, preferredEdge: .maxX)
    view.window?.makeFirstResponder(text)
  }
  func popoverDidClose(_ notification: Notification) {
    onClose?(text.string, answered.state == .on)
    onClose = nil
  }
}
