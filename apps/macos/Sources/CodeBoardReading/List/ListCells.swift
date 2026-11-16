import AppKit
import CodeBoardResources

/// The list's table: Return and a double-click open a row (`onOpen`), a single click selects it, ↑ and ↓ as any table.
/// A field's cell takes them first (`onEdit`, false: not taken): a double-click, or Return in the column last clicked,
/// edits it, a single click on one that edits by a menu shows it (`click`)
final class ListTable: NSTableView {
  var onOpen: (Int) -> Void = { _ in }
  var onDelete: () -> Void = {}
  var onEdit: (_ row: Int, _ column: Int, _ click: Bool) -> Bool = { _, _, _ in false }
  /// A ⌘-click on a cell, taken (true) before it changes the selection
  var onCommandClick: (_ row: Int, _ column: Int) -> Bool = { _, _ in false }
  /// The column of the last click on a row
  private(set) var lastColumn = -1

  override func keyDown(with event: NSEvent) {
    switch event.specialKey {
    case .carriageReturn?, .enter?:
      if selectedRow >= 0, !onEdit(selectedRow, lastColumn, false) { onOpen(selectedRow) }
    case .delete?, .deleteForward?: onDelete()
    default: super.keyDown(with: event)
    }
  }

  override func mouseDown(with event: NSEvent) {
    let at = convert(event.locationInWindow, from: nil)
    let (row, col) = (row(at: at), column(at: at))
    lastColumn = col
    if event.clickCount == 2, row >= 0 {
      if !onEdit(row, col, false) { onOpen(row) }
      return
    }
    let flags = event.modifierFlags.intersection([.command, .shift, .option, .control])
    if event.clickCount == 1, flags == .command, row >= 0, col >= 0, onCommandClick(row, col) { return }
    super.mouseDown(with: event)
    // a plain click let go in its cell, not a drag or a selection extended
    let plain = event.modifierFlags.intersection([.command, .shift, .option, .control]).isEmpty
    guard event.clickCount == 1, row >= 0, col >= 0, plain, let up = NSApp.currentEvent, up.type == .leftMouseUp
    else { return }
    let end = convert(up.locationInWindow, from: nil)
    if self.row(at: end) == row, column(at: end) == col { _ = onEdit(row, col, true) }
  }

  /// A right-click on a row outside the selection selects it first: the menu's Delete deletes what is selected
  override func menu(for event: NSEvent) -> NSMenu? {
    let row = row(at: convert(event.locationInWindow, from: nil))
    guard row >= 0 else { return nil }
    if !selectedRowIndexes.contains(row) { selectRowIndexes([row], byExtendingSelection: false) }
    return super.menu(for: event)
  }
}

/// The header row in the pane's ink on its paper, no system band: each column's title small and quiet, the sorted
/// column's darker with its chevron, a hairline under them all. A click sorts, as on any table header
final class ListHeaderView: NSTableHeaderView {
  var ink = NSColor.labelColor
  /// A right-click's menu, by the column under it
  var onMenu: (Int) -> NSMenu? = { _ in nil }

  override func menu(for event: NSEvent) -> NSMenu? {
    let col = column(at: convert(event.locationInWindow, from: nil))
    return col >= 0 ? onMenu(col) : nil
  }

  override func draw(_ dirtyRect: NSRect) {
    guard let table = tableView else { return }
    let first = table.sortDescriptors.first
    for (i, col) in table.tableColumns.enumerated() {
      let r = headerRect(ofColumn: i)
      let sorted = first?.key == col.identifier.rawValue
      let font = NSFont.systemFont(ofSize: 11, weight: sorted ? .semibold : .medium)
      let attrs: [NSAttributedString.Key: Any] = [
        .font: font, .foregroundColor: ink.withAlphaComponent(sorted ? 0.75 : 0.5),
      ]
      // the + that adds a field, in the middle of its narrow column
      let add = col.identifier.rawValue == ListColumn.addID
      let title = (add ? "+" : col.title) as NSString
      let size = title.size(withAttributes: add ? attrs.merging([.font: NSFont.systemFont(ofSize: 14)]) { $1 } : attrs)
      if add {
        title.draw(
          at: CGPoint(x: (r.midX - size.width / 2).rounded(), y: (r.midY - size.height / 2).rounded()),
          withAttributes: attrs.merging([.font: NSFont.systemFont(ofSize: 14)]) { $1 })
        continue
      }
      // on the cells' text, which a label draws 2 in from its frame
      let x = r.minX + ListCell.inset + 2
      let y = (r.midY - size.height / 2).rounded()
      title.draw(
        with: CGRect(x: x, y: y, width: max(0, r.width - ListCell.inset * 2 - 12), height: size.height),
        options: [.usesLineFragmentOrigin, .truncatesLastVisibleLine], attributes: attrs)
      if sorted, let first {
        let symbol = NSImage(
          systemSymbolName: first.ascending ? "chevron.up" : "chevron.down", accessibilityDescription: nil)?
          .withSymbolConfiguration(.init(pointSize: 8, weight: .bold).applying(.init(paletteColors: [ink])))
        if let symbol {
          let at = CGPoint(
            x: min(x + size.width + 5, r.maxX - symbol.size.width - 4), y: r.midY - symbol.size.height / 2)
          symbol.draw(
            in: CGRect(origin: at, size: symbol.size).integral, from: .zero, operation: .sourceOver, fraction: 0.6,
            respectFlipped: true, hints: nil)
        }
      }
    }
    ink.withAlphaComponent(0.12).setFill()
    CGRect(x: 0, y: bounds.maxY - 1, width: bounds.width, height: 1).fill()
  }
}

/// A row lit as the minimal list's was: the ink faintly over it, rounded, inset from the sides; its text never turned
/// white
final class ListRowView: NSTableRowView {
  var ink = NSColor.labelColor

  override var interiorBackgroundStyle: NSView.BackgroundStyle { .normal }

  override func drawSelection(in dirtyRect: NSRect) {
    ink.withAlphaComponent(isEmphasized ? 0.09 : 0.06).setFill()
    NSBezierPath(roundedRect: bounds.insetBy(dx: 6, dy: 1), xRadius: 6, yRadius: 6).fill()
  }
}

/// One cell: its column's value, the detail under it in a smaller, quieter line when the column has one; a paper's
/// translation on the title's line (how far it is, or that it failed, with Retry and the reason under the title)
final class ListCell: NSTableCellView {
  static let inset: CGFloat = 8
  let line = NSTextField(labelWithString: "")
  let detail = NSTextField(labelWithString: "")
  let status = NSTextField(labelWithString: "")
  let retry = NSButton(title: "Retry", target: nil, action: nil)
  /// A checkbox field's box, toggled by one click (`onToggle`)
  let check = NSButton(checkboxWithTitle: "", target: nil, action: nil)
  var onToggle: ((Bool) -> Void)?
  /// Under a select field's label: its option's colour, rounded
  let pill = NSView()
  /// The boards column: names fitted to the width on each layout
  private var names: [String]?
  private var twoLines = false
  private var onRetry: (() -> Void)?

  init(_ id: NSUserInterfaceItemIdentifier) {
    super.init(frame: .zero)
    identifier = id
    line.font = .systemFont(ofSize: 13)
    detail.font = .systemFont(ofSize: 11)
    status.font = .systemFont(ofSize: 11)
    for f in [line, detail, status] {
      f.lineBreakMode = .byTruncatingTail
      f.cell?.truncatesLastVisibleLine = true
      addSubview(f)
    }
    textField = line
    retry.isBordered = false
    retry.target = self
    retry.action = #selector(retried)
    retry.setAccessibilityIdentifier("ui-listretry")
    addSubview(retry)
    check.target = self
    check.action = #selector(toggled)
    check.setAccessibilityIdentifier("ui-listcheck")
    addSubview(check)
    pill.wantsLayer = true
    pill.layer?.cornerRadius = 8
    addSubview(pill, positioned: .below, relativeTo: line)
  }

  @available(*, unavailable)
  required init?(coder: NSCoder) {
    fatalError("ListCell is not loaded from nibs")
  }

  override var isFlipped: Bool { true }

  func show(_ c: ListColumn, _ row: ListRow, ink: NSColor, twoLines: Bool, retry: @escaping (TranslationJob) -> Void) {
    self.twoLines = twoLines
    names = c.id == "boards" ? row.boards : nil
    line.stringValue = c.value(row)
    // what it is, said to VoiceOver with the title
    setAccessibilityLabel(c.id == "title" ? "\(row.title), \(row.kind)" : nil)
    line.lineBreakMode = names == nil ? .byTruncatingTail : .byTruncatingMiddle
    line.textColor = c.id == "title" ? ink : ink.withAlphaComponent(0.7)
    line.font = .systemFont(ofSize: c.id == "title" ? 13 : 12)
    detail.stringValue = c.detail?(row) ?? ""
    detail.textColor = ink.withAlphaComponent(0.5)
    detail.toolTip = nil
    status.stringValue = ""
    status.textColor = ink.withAlphaComponent(0.5)
    onRetry = nil
    if c.id == "title", let t = row.translation {
      status.stringValue = VersionsBar.jobTitle(t.state)
      if case .failed(let why) = t.state {
        status.textColor = .systemRed
        detail.stringValue = [why.stage, why.message].compactMap { $0 }.joined(separator: ": ")
        detail.textColor = NSColor.systemRed.withAlphaComponent(0.85)
        detail.toolTip = why.message
        onRetry = { retry(t.job) }
        // an action in the ink, as the versions bar's
        self.retry.attributedTitle = NSAttributedString(
          string: "Retry", attributes: [.font: NSFont.systemFont(ofSize: 11, weight: .semibold), .foregroundColor: ink])
      }
    }
    detail.isHidden = c.detail == nil && onRetry == nil
    status.isHidden = status.stringValue.isEmpty
    self.retry.isHidden = onRetry == nil
    onToggle = nil
    let box = c.field?.type == .checkbox
    check.isHidden = !box
    line.isHidden = box
    if let f = c.field, box { check.state = row.fields[f.id] == .bool(true) ? .on : .off }
    let tint = c.field.flatMap { ListColumn.tint(of: $0, row) }
    pill.isHidden = tint == nil
    pill.layer?.backgroundColor = tint?.cgColor
    if tint != nil { line.textColor = ink.withAlphaComponent(0.85) }
    needsLayout = true
  }

  @objc private func retried() { onRetry?() }
  @objc private func toggled() { onToggle?(check.state == .on) }

  override func layout() {
    super.layout()
    let w = bounds.width - Self.inset * 2
    // one line in the middle of the row; two from the middle out, each on its own line height
    let top = twoLines ? ((bounds.height - 31) / 2).rounded() : ((bounds.height - 17) / 2).rounded()
    var right = bounds.width - Self.inset
    if !retry.isHidden {
      let rw = ceil(retry.intrinsicContentSize.width)
      retry.frame = CGRect(x: right - rw, y: top, width: rw, height: 17)
      right -= rw + 6
    }
    if !status.isHidden {
      let sw = ceil(status.intrinsicContentSize.width) + 4
      status.frame = CGRect(x: right - sw, y: top + 2, width: sw, height: 15)
      right -= sw + 8
    }
    if let names { line.stringValue = EntryBoards.fit(names, width: w - 4, font: line.font ?? .systemFont(ofSize: 12)) }
    let lineTop = line.font?.pointSize == 13 ? top : top + 1
    line.frame = CGRect(x: Self.inset, y: lineTop, width: max(0, right - Self.inset), height: 17)
    if !pill.isHidden {
      // the label inside its pill, the pill as wide as the label needs and no wider than the cell
      line.frame.origin.x += 6
      line.frame.size.width = max(0, min(ceil(line.intrinsicContentSize.width), line.frame.width - 12))
      pill.frame = CGRect(x: Self.inset, y: lineTop, width: line.frame.width + 12, height: 17)
    }
    check.frame = CGRect(x: Self.inset, y: top, width: 18, height: 17)
    detail.frame = CGRect(x: Self.inset, y: top + 17, width: max(0, w), height: 14)
  }
}
