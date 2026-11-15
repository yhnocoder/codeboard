import AppKit
import CodeBoardMarkdown

/// The table band's size grid (tableview.ts GridPick): above the size button, a 10 × 8 grid whose hovered cell sets rows
/// × columns (the header counts as row 1), the same in two fields, Apply, and a warning of the cells with content a
/// smaller size drops. A click on a cell or Apply resizes the table (one undo step); Esc or a press elsewhere closes it
@MainActor
final class TableSizePicker: NSView, NSTextFieldDelegate {
  static let cols = 10
  static let rows = 8
  private let cell: CGFloat = 18
  private let gap: CGFloat = 2
  private let pad: CGFloat = 10
  private let rowsField = NSTextField()
  private let colsField = NSTextField()
  private let apply = NSButton(title: "Apply", target: nil, action: nil)
  private var theme: MarkdownTheme?
  /// the table's size now, the size picked, and how many cells with content the picked size drops
  private var current = (r: 1, c: 1)
  private(set) var picked = (r: 1, c: 1)
  private var dropped = 0
  var onPick: (Int, Int) -> Void = { _, _ in }
  /// what a size would drop (the host's question to the editing rules)
  var dropsAt: (Int, Int) -> Int = { _, _ in 0 }

  override init(frame: NSRect) {
    super.init(frame: frame)
    wantsLayer = true
    for (f, label) in [(rowsField, "Rows"), (colsField, "Columns")] {
      f.placeholderString = label
      f.font = .systemFont(ofSize: 12)
      f.bezelStyle = .roundedBezel
      f.delegate = self
      addSubview(f)
    }
    apply.bezelStyle = .push
    apply.controlSize = .small
    apply.target = self
    apply.action = #selector(applyPressed)
    addSubview(apply)
    isHidden = true
  }

  @available(*, unavailable)
  required init?(coder: NSCoder) { fatalError() }

  override var isFlipped: Bool { true }

  private var gridOrigin: CGPoint { CGPoint(x: pad, y: pad + 22) }
  private var gridSize: CGSize {
    CGSize(
      width: CGFloat(Self.cols) * (cell + gap) - gap, height: CGFloat(Self.rows) * (cell + gap) - gap)
  }

  /// Opens above `anchor` (the size button's box in the superview's points) for a table of `rows` × `cols`
  func open(above anchor: CGRect, rows: Int, cols: Int, theme: MarkdownTheme) {
    self.theme = theme
    current = (rows, cols)
    let w = gridSize.width + 2 * pad
    let h = pad + 22 + gridSize.height + 10 + 24 + 18 + pad
    let room = superview?.bounds.width ?? w
    // above the size button; below it when the part of the Note in view has no room above
    let seen = superview?.visibleRect ?? .infinite
    let y = anchor.minY - h - 6 >= seen.minY ? anchor.minY - h - 6 : anchor.maxY + 6
    frame = CGRect(x: max(0, min(anchor.minX - 4, room - w)), y: y, width: w, height: h)
    let fy = gridOrigin.y + gridSize.height + 10
    rowsField.frame = CGRect(x: pad, y: fy, width: 56, height: 22)
    colsField.frame = CGRect(x: pad + 62, y: fy, width: 56, height: 22)
    apply.frame = CGRect(x: w - pad - 64, y: fy - 1, width: 64, height: 24)
    isHidden = false
    pick(rows, cols)
  }

  func close() { isHidden = true }

  func pick(_ r: Int, _ c: Int) {
    picked = (max(1, min(40, r)), max(1, min(12, c)))
    rowsField.stringValue = "\(picked.r)"
    colsField.stringValue = "\(picked.c)"
    dropped = dropsAt(picked.r, picked.c)
    needsDisplay = true
  }

  @objc private func applyPressed() {
    let r = Int(rowsField.stringValue) ?? picked.r
    let c = Int(colsField.stringValue) ?? picked.c
    close()
    onPick(max(1, min(40, r)), max(1, min(12, c)))
  }

  func controlTextDidChange(_ n: Notification) {
    pick(Int(rowsField.stringValue) ?? picked.r, Int(colsField.stringValue) ?? picked.c)
  }

  func control(_ control: NSControl, textView: NSTextView, doCommandBy sel: Selector) -> Bool {
    if sel == #selector(NSResponder.insertNewline(_:)) {
      applyPressed()
      return true
    }
    if sel == #selector(NSResponder.cancelOperation(_:)) {
      close()
      return true
    }
    return false
  }

  private func cellAt(_ p: CGPoint) -> (Int, Int)? {
    let x = p.x - gridOrigin.x
    let y = p.y - gridOrigin.y
    guard x >= 0, y >= 0, x < gridSize.width, y < gridSize.height else { return nil }
    return (Int(y / (cell + gap)) + 1, Int(x / (cell + gap)) + 1)
  }

  override func updateTrackingAreas() {
    super.updateTrackingAreas()
    for t in trackingAreas { removeTrackingArea(t) }
    addTrackingArea(NSTrackingArea(rect: .zero, options: [.mouseMoved, .activeAlways, .inVisibleRect], owner: self))
  }

  override func mouseMoved(with e: NSEvent) {
    if let (r, c) = cellAt(convert(e.locationInWindow, from: nil)), r != picked.r || c != picked.c { pick(r, c) }
  }

  override func mouseDown(with e: NSEvent) {
    guard let (r, c) = cellAt(convert(e.locationInWindow, from: nil)) else { return }
    close()
    onPick(r, c)
  }

  override func draw(_ dirtyRect: NSRect) {
    guard let theme, let ctx = NSGraphicsContext.current?.cgContext else { return }
    let box = CGPath(roundedRect: bounds.insetBy(dx: 0.5, dy: 0.5), cornerWidth: 10, cornerHeight: 10, transform: nil)
    ctx.saveGState()
    ctx.setShadow(offset: CGSize(width: 0, height: 4), blur: 14, color: CGColor(gray: 0, alpha: 0.16))
    ctx.addPath(box)
    ctx.setFillColor(theme.colors.surface.cg)
    ctx.fillPath()
    ctx.restoreGState()
    ctx.addPath(box)
    ctx.setStrokeColor(theme.colors.hair.cg)
    ctx.strokePath()
    let ink = NSColor(cgColor: theme.colors.ink.cg) ?? .labelColor
    let ink3 = NSColor(cgColor: theme.colors.ink3.cg) ?? .tertiaryLabelColor
    ("\(picked.r) × \(picked.c)" as NSString).draw(
      at: CGPoint(x: pad, y: pad),
      withAttributes: [.font: NSFont.systemFont(ofSize: 12, weight: .semibold), .foregroundColor: ink])
    let hint = "Header counts as row 1" as NSString
    let ha: [NSAttributedString.Key: Any] = [.font: NSFont.systemFont(ofSize: 11), .foregroundColor: ink3]
    hint.draw(at: CGPoint(x: bounds.width - pad - hint.size(withAttributes: ha).width, y: pad + 1), withAttributes: ha)
    for r in 0..<Self.rows {
      for c in 0..<Self.cols {
        let rect = CGRect(
          x: gridOrigin.x + CGFloat(c) * (cell + gap), y: gridOrigin.y + CGFloat(r) * (cell + gap), width: cell,
          height: cell)
        let inPick = r < picked.r && c < picked.c
        let inTable = r < current.r && c < current.c
        // the cells a smaller size would take away, marked warning; the picked size accent; the table's own faint
        let fill: MDColor =
          inTable && !inPick && dropped > 0
          ? MDColor(0.85, 0.3, 0.25, 0.35)
          : inPick
            ? theme.colors.accent.alpha(0.3) : inTable ? theme.colors.ink.alpha(0.1) : theme.colors.ink.alpha(0.04)
        ctx.addPath(CGPath(roundedRect: rect, cornerWidth: 3, cornerHeight: 3, transform: nil))
        ctx.setFillColor(fill.cg)
        ctx.fillPath()
      }
    }
    if dropped > 0 {
      let warn = "\(dropped) cell\(dropped > 1 ? "s" : "") with content will be removed" as NSString
      warn.draw(
        at: CGPoint(x: pad, y: bounds.height - pad - 15),
        withAttributes: [.font: NSFont.systemFont(ofSize: 11), .foregroundColor: NSColor.systemRed])
    }
  }
}
