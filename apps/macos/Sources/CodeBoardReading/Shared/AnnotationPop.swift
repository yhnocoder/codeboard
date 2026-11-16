import AppKit

/// The small popup that annotates a passage, after the board's sidenote popup (NativePop: its surface, its radius of
/// 14 and its shadow, 12.5-point text): the passage's annotations, each with a button that removes it, then an input
/// and the ? that makes what is written a question. ↵ adds what is written (⌥↵ a new line), Esc closes. What is
/// written is plain text kept as Markdown; it is shown as written, not drawn as Markdown
public final class AnnotationPop: NSView, NSTextViewDelegate {
  public struct Note: Equatable {
    public var id: String
    public var text: String
    public var question: Bool

    public init(id: String, text: String, question: Bool) {
      self.id = id
      self.text = text
      self.question = question
    }
  }

  public var notes: [Note] {
    didSet { if notes != oldValue { rebuild() } }
  }
  /// What was written, and whether as a question
  public var onAdd: ((String, Bool) -> Void)?
  public var onRemove: ((String) -> Void)?
  public var onClose: (() -> Void)?
  public var look: ReadingBarLook {
    didSet { restyle() }
  }
  public let input = NSTextView()
  public let ask = NSButton()
  public let add = NSButton()
  private let scroll = NSScrollView()
  private var rows: [(label: NSTextField, remove: NSButton)] = []
  private let width: CGFloat
  static let pad: CGFloat = 12
  static let inputHeight: CGFloat = 54
  static let font = NSFont.systemFont(ofSize: 12.5)

  public init(notes: [Note], width: CGFloat, look: ReadingBarLook = .warmInk(dark: false)) {
    self.notes = notes
    self.width = width
    self.look = look
    super.init(frame: .zero)
    setAccessibilityIdentifier("ui-annotationpop")
    wantsLayer = true
    input.font = Self.font
    input.isRichText = false
    input.allowsUndo = true
    input.delegate = self
    input.textContainerInset = CGSize(width: 4, height: 6)
    input.isVerticallyResizable = true
    input.autoresizingMask = [.width]
    input.setAccessibilityIdentifier("ui-annotationinput")
    scroll.documentView = input
    scroll.hasVerticalScroller = true
    scroll.drawsBackground = false
    scroll.wantsLayer = true
    scroll.layer?.cornerRadius = 7
    scroll.layer?.borderWidth = 0.5
    ask.setButtonType(.pushOnPushOff)
    ask.isBordered = false
    ask.wantsLayer = true
    ask.layer?.cornerRadius = 7
    ask.toolTip = "Ask as a Question"
    ask.setAccessibilityIdentifier("ui-annotationquestion")
    ask.target = self
    ask.action = #selector(showAsked)
    add.title = "Add"
    add.bezelStyle = .push
    add.toolTip = "Add"
    add.target = self
    add.action = #selector(addWritten)
    add.setAccessibilityIdentifier("ui-annotationadd")
    for v in [scroll, ask, add] { addSubview(v) }
    rebuild()
  }

  @available(*, unavailable)
  required init?(coder: NSCoder) { fatalError("AnnotationPop is not loaded from nibs") }

  public override var isFlipped: Bool { true }

  private var textWidth: CGFloat { width - 2 * Self.pad - 26 }

  private func rebuild() {
    for r in rows {
      r.label.removeFromSuperview()
      r.remove.removeFromSuperview()
    }
    rows = notes.enumerated().map { i, n in
      let label = NSTextField(wrappingLabelWithString: n.question ? "? " + n.text : n.text)
      label.font = Self.font
      label.isSelectable = false
      label.preferredMaxLayoutWidth = textWidth
      label.setAccessibilityIdentifier("ui-annotationnote\(i + 1)")
      let remove = NSButton(
        image: NSImage(systemSymbolName: "xmark", accessibilityDescription: "Remove") ?? NSImage(), target: self,
        action: #selector(removeNote(_:)))
      remove.isBordered = false
      remove.tag = i
      remove.toolTip = "Remove"
      remove.setAccessibilityIdentifier("ui-annotationremove\(i + 1)")
      addSubview(label)
      addSubview(remove)
      return (label, remove)
    }
    restyle()
    layOut()
  }

  /// Its size for its notes
  public var size: CGSize {
    let notesHeight = rows.reduce(0) { $0 + $1.label.fittingSize.height + 8 }
    return CGSize(width: width, height: Self.pad + notesHeight + Self.inputHeight + 8 + 24 + Self.pad)
  }

  private func layOut() {
    setFrameSize(size)
    var y = Self.pad
    for r in rows {
      let h = r.label.fittingSize.height
      r.label.frame = CGRect(x: Self.pad, y: y, width: textWidth, height: h)
      r.remove.frame = CGRect(x: width - Self.pad - 20, y: y, width: 20, height: 20)
      y += h + 8
    }
    scroll.frame = CGRect(x: Self.pad, y: y, width: width - 2 * Self.pad, height: Self.inputHeight)
    input.frame = CGRect(origin: .zero, size: scroll.contentSize)
    y += Self.inputHeight + 8
    ask.frame = CGRect(x: Self.pad, y: y, width: 28, height: 24)
    add.frame = CGRect(x: width - Self.pad - 64, y: y, width: 64, height: 24)
  }

  private func restyle() {
    showAsked()
    appearance = NSAppearance(named: look.dark ? .darkAqua : .aqua)
    guard let l = layer else { return }
    l.backgroundColor = look.paper
    l.cornerRadius = 14
    l.cornerCurve = .continuous
    l.shadowColor = CGColor(gray: 0, alpha: 1)
    l.shadowOpacity = look.dark ? 0.5 : 0.22
    l.shadowRadius = 16
    l.shadowOffset = CGSize(width: 0, height: -10)
    scroll.layer?.borderColor = look.ring
    let ink = NSColor(cgColor: look.ink) ?? .labelColor
    input.textColor = ink
    input.insertionPointColor = ink
    for (r, n) in zip(rows, notes) {
      r.label.textColor = n.question ? NSColor(cgColor: look.ask) : ink
      r.remove.contentTintColor = ink
    }
  }

  @objc func addWritten() {
    let text = input.string.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !text.isEmpty else { return }
    onAdd?(text, ask.state == .on)
    input.string = ""
    ask.state = .off
    showAsked()
  }

  /// On, the "?" is filled with the questions' colour: what is written will be asked
  @objc private func showAsked() {
    let on = ask.state == .on
    ask.layer?.backgroundColor = on ? look.ask : look.ink.copy(alpha: 0.07)
    ask.attributedTitle = NSAttributedString(
      string: "?",
      attributes: [
        .foregroundColor: on ? NSColor.white : NSColor(cgColor: look.ink) ?? .labelColor,
        .font: NSFont.systemFont(ofSize: 12.5, weight: .semibold),
      ])
  }

  @objc private func removeNote(_ sender: NSButton) {
    if notes.indices.contains(sender.tag) { onRemove?(notes[sender.tag].id) }
  }

  public func textView(_ textView: NSTextView, doCommandBy selector: Selector) -> Bool {
    switch selector {
    case #selector(NSResponder.insertNewline(_:)):
      addWritten()
      return true
    case #selector(NSResponder.cancelOperation(_:)):
      onClose?()
      return true
    default: return false
    }
  }

  /// Where the popup goes for a passage whose lines are `lines` (y-down) in the part of the view shown, `visible`:
  /// `gap` below its last line, starting where its first line starts; above its first line only when there is no room
  /// below; near the edges shifted sideways only. Neither place is over a line of the passage
  public static func origin(size: CGSize, lines: [CGRect], visible: CGRect, gap: CGFloat = 6) -> CGPoint {
    guard let first = lines.min(by: { $0.minY < $1.minY }), let last = lines.max(by: { $0.maxY < $1.maxY })
    else { return visible.origin }
    let x = max(visible.minX, min(first.minX, visible.maxX - size.width))
    let below = last.maxY + gap
    return CGPoint(x: x, y: below + size.height <= visible.maxY ? below : first.minY - gap - size.height)
  }
}
