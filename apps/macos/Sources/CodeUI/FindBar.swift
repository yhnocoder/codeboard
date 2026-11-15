import AppKit

/// A find (and replace) bar: the query, the count of matches, the host's buttons beside it (Match Case, back and on),
/// and the replacement under them when asked for. ↵ and ⇧↵ in the query go on and back, ↵ in the replacement replaces
/// the current match and ⌘↵ all of them, Esc closes it; what they do is the host's (`onChange`, `onStep`, `onReplace`,
/// `onClose`). How it looks is the host's too. The code editor and the Markdown editor both show it
@MainActor
public final class FindBar: NSView, NSTextFieldDelegate {
  public struct Look {
    public var fill: CGColor
    public var line: CGColor
    public var radius: CGFloat

    public init(fill: CGColor, line: CGColor, radius: CGFloat) {
      self.fill = fill
      self.line = line
      self.radius = radius
    }
  }

  public let query = NSTextField()
  public let replacement = NSTextField()
  public let count = NSTextField(labelWithString: "")
  /// The host's buttons right of the count, 72 wide and 24 tall; none: the bar is that much narrower
  public var buttons: NSView? {
    didSet {
      oldValue?.removeFromSuperview()
      if let buttons { addSubview(buttons) }
      needsLayout = true
    }
  }
  public var caseSensitive = false { didSet { onCase(caseSensitive) } }
  public private(set) var replacing = false
  public var onChange: () -> Void = {}
  public var onStep: (Bool) -> Void = { _ in }
  public var onReplace: (Bool) -> Void = { _ in }
  public var onClose: () -> Void = {}
  /// Match Case was turned on or off (the host's button shows it)
  public var onCase: (Bool) -> Void = { _ in }

  /// Its size: 286 by 40 with buttons, 70 tall with the replacement
  public var size: CGSize { CGSize(width: buttons == nil ? 214 : 286, height: replacing ? 70 : 40) }

  public override init(frame: NSRect) {
    super.init(frame: frame)
    wantsLayer = true
    layer?.borderWidth = 1
    for (f, p) in [(query, "Find"), (replacement, "Replace")] {
      f.placeholderString = p
      f.bezelStyle = .roundedBezel
      f.font = .systemFont(ofSize: 12)
      f.delegate = self
      addSubview(f)
    }
    count.font = .monospacedDigitSystemFont(ofSize: 11, weight: .regular)
    count.textColor = .secondaryLabelColor
    addSubview(count)
    isHidden = true
  }

  @available(*, unavailable)
  required init?(coder: NSCoder) { fatalError() }

  public override var isFlipped: Bool { true }

  public override func layout() {
    super.layout()
    query.frame = CGRect(x: 8, y: 8, width: 150, height: 24)
    count.frame = CGRect(x: 162, y: 12, width: 44, height: 16)
    buttons?.frame = CGRect(x: 206, y: 8, width: 72, height: 24)
    replacement.frame = CGRect(x: 8, y: 38, width: 150, height: 24)
    replacement.isHidden = !replacing
  }

  /// A new look while shown
  public func restyle(_ look: Look) {
    layer?.backgroundColor = look.fill
    layer?.borderColor = look.line
    layer?.cornerRadius = look.radius
  }

  /// Shown at the top right of `visible`, the keys in the query (in the replacement when replacing with a query)
  public func show(replace: Bool, look: Look, in visible: CGRect) {
    replacing = replace
    restyle(look)
    frame = CGRect(origin: CGPoint(x: visible.maxX - size.width - 6, y: visible.minY + 8), size: size)
    isHidden = false
    needsLayout = true
    window?.makeFirstResponder(replace && !query.stringValue.isEmpty ? replacement : query)
  }

  public func close() {
    guard !isHidden else { return }
    isHidden = true
    onClose()
  }

  public func controlTextDidChange(_ n: Notification) {
    if (n.object as? NSTextField) === query { onChange() }
  }

  public func control(_ control: NSControl, textView: NSTextView, doCommandBy sel: Selector) -> Bool {
    let shift = NSApp.currentEvent?.modifierFlags.contains(.shift) ?? false
    let cmd = NSApp.currentEvent?.modifierFlags.contains(.command) ?? false
    switch sel {
    case #selector(NSResponder.insertNewline(_:)):
      if control === replacement { onReplace(cmd) } else { onStep(!shift) }
      return true
    case #selector(NSResponder.cancelOperation(_:)):
      close()
      return true
    default:
      return false
    }
  }
}
