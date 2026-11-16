import AppKit
import CodeBoardModel
import CodeBoardResources

// The resource's own fields (FORMAT.md, resource.json): a column each after the preset's, in the file's order. The +
// at the header's end adds one, named for its kind and renamed at once; a field's header menu renames or deletes it
// (its values stay in the entries' files, not shown). A text, number or date value is typed over its cell (a
// double-click, or Return in the column last clicked; Esc cancels, Return or leaving commits), a checkbox toggles on a
// click, a select or board value is chosen from a menu its cell shows on a click. A value changed writes that one
// entry's file (a file that is an entry alone becomes an entry first, ListDrag's `promoted`) and that row alone is read
// again; a field or an option changed writes the resource file and the list is read again. No undo, as the list's
// other edits

extension ListColumn {
  static let addID = "+field"

  /// The column of one of the resource's fields; `boards`: the vault's board titles by board id
  static func field(_ f: Resource.Field, boards: [String: String]) -> ListColumn {
    let raw = { (row: ListRow) in row.fields[f.id] }
    let text = { (row: ListRow) in raw(row).map { f.shown($0, boards: boards) } ?? "" }
    let order: (ListRow, ListRow) -> Bool =
      switch f.type {
      case .number: { (raw($0)?.number ?? .infinity) < (raw($1)?.number ?? .infinity) }
      // a day as the file writes it sorts as it reads
      case .date: { (raw($0)?.text ?? "") < (raw($1)?.text ?? "") }
      case .checkbox: { raw($0) != .bool(true) && raw($1) == .bool(true) }
      case .select: { f.place(raw($0)) < f.place(raw($1)) }
      case .text, .board: { text($0).localizedStandardCompare(text($1)) == .orderedAscending }
      }
    var c = ListColumn(
      id: "field:" + f.id, title: f.name, width: f.type == .checkbox ? 72 : 120, value: text,
      searched: [.text, .select, .board].contains(f.type), order: order, ascending: f.type != .checkbox)
    c.field = f
    if f.type != .checkbox { c.blank = { raw($0) == nil } }
    return c
  }

  /// A select value's pill colour: its option's, else the one of its place among the options; nil when it names none
  static func tint(of f: Resource.Field, _ row: ListRow) -> NSColor? {
    guard f.type == .select, let id = row.fields[f.id]?.text, let i = f.options?.firstIndex(where: { $0.id == id })
    else { return nil }
    return tint(f.options![i].color, at: i)
  }

  static func tint(_ color: Highlight.Color?, at i: Int) -> NSColor {
    let cycle: [Highlight.Color] = [.yellow, .green, .blue, .pink, .purple]
    return PDFPlaces.color(color ?? cycle[i % cycle.count])
  }

  /// A day as a date field writes it (`YYYY-MM-DD`, this machine's day); nil for anything else
  static func isoDay(_ s: String) -> Date? {
    let d = isoDays.date(from: s)
    return d.flatMap { isoDays.string(from: $0) == s ? $0 : nil }
  }

  static let isoDays: DateFormatter = {
    let f = DateFormatter()
    f.locale = Locale(identifier: "en_US_POSIX")
    f.dateFormat = "yyyy-MM-dd"
    f.isLenient = false
    return f
  }()

  /// A number as it is shown and typed: whole ones without a point
  static func number(_ n: Double) -> String {
    n == n.rounded() && abs(n) < 1e15 ? String(Int64(n)) : String(n)
  }
}

extension Entry.Value {
  var text: String? { if case .text(let s) = self { s } else { nil } }
  var number: Double? { if case .number(let n) = self { n } else { nil } }
}

extension Resource.Field {
  /// What its cell says for `v`
  func shown(_ v: Entry.Value, boards: [String: String]) -> String {
    switch (type, v) {
    case (.checkbox, _): ""
    case (.select, .text(let id)): options?.first { $0.id == id }?.name ?? "deleted option"
    case (.board, .text(let id)): boards[id] ?? "Not found"
    case (.date, .text(let s)): ListColumn.isoDay(s).map(ListColumn.day) ?? s
    case (_, .text(let s)): s
    case (_, .number(let n)): ListColumn.number(n)
    case (_, .bool(let b)): b ? "Yes" : "No"
    }
  }

  /// Where a select value sorts: its option's place, after them all one that names none
  func place(_ v: Entry.Value?) -> Int {
    let options = options ?? []
    return v?.text.flatMap { id in options.firstIndex { $0.id == id } } ?? options.count
  }

  /// What typing `s` in its cell makes: nil when it is not one of its values, `.some(nil)` (nothing typed) a value
  /// cleared
  func typed(_ s: String) -> Entry.Value?? {
    let t = s.trimmingCharacters(in: .whitespacesAndNewlines)
    if t.isEmpty { return .some(nil) }
    switch type {
    case .number: return Double(t).flatMap { $0.isFinite ? .number($0) : nil }
    case .date: return ListColumn.isoDay(t) == nil ? nil : .text(t)
    case .text: return .text(t)
    case .checkbox, .select, .board: return nil
    }
  }

  /// What its cell shows while typed in
  func typing(_ v: Entry.Value?) -> String {
    switch v {
    case .text(let s)?: s
    case .number(let n)?: ListColumn.number(n)
    case .bool, nil: ""
    }
  }

  static func name(of kind: Kind) -> String {
    switch kind {
    case .text: "Text"
    case .number: "Number"
    case .date: "Date"
    case .select: "Select"
    case .checkbox: "Checkbox"
    case .board: "Board"
    }
  }
}

/// A menu item that runs what it was made with
final class ListMenuItem: NSMenuItem {
  private var run: () -> Void = {}

  convenience init(_ title: String, _ run: @escaping () -> Void) {
    self.init(title: title, action: #selector(fire), keyEquivalent: "")
    self.run = run
    target = self
  }

  @objc private func fire() { run() }
}

extension ListTabView {
  static let kinds: [Resource.Field.Kind] = [.text, .number, .date, .select, .checkbox, .board]

  /// The field a column shows, by the column's index in the table
  func field(at column: Int) -> Resource.Field? {
    guard table.tableColumns.indices.contains(column) else { return nil }
    let id = table.tableColumns[column].identifier.rawValue
    return columns.first { $0.id == id }?.field
  }

  // MARK: Fields

  /// The + header's menu: a field of each kind
  func addFieldMenu() -> NSMenu {
    let m = NSMenu()
    for k in Self.kinds {
      m.addItem(
        ListMenuItem(Resource.Field.name(of: k)) { [weak self] in
          guard let self, let f = addField(k) else { return }
          renameInHeader(f.id)
        })
    }
    return m
  }

  /// A new field of `kind` after the others, named for its kind (` 2`, ` 3`… when taken)
  @discardableResult
  func addField(_ kind: Resource.Field.Kind) -> Resource.Field? {
    let base = Resource.Field.name(of: kind)
    let names = Set(fields.map(\.name))
    let name = ([base] + (2...999).map { "\(base) \($0)" }).first { !names.contains($0) } ?? base
    let f = Resource.Field(id: Board.newID("f"), name: name, type: kind)
    return changeResource { $0.fields.append(f) } ? f : nil
  }

  @discardableResult
  func renameField(_ id: String, to name: String) -> Bool {
    let name = name.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !name.isEmpty else {
      NSSound.beep()
      return false
    }
    return changeResource { r in
      for i in r.fields.indices where r.fields[i].id == id { r.fields[i].name = name }
    }
  }

  /// The field gone from the resource; the entries keep their values
  func removeField(_ id: String) {
    changeResource { $0.fields.removeAll { $0.id == id } }
  }

  /// The question before a field is deleted
  static func deleteFieldQuestion(_ name: String) -> NSAlert {
    let a = NSAlert()
    a.alertStyle = .warning
    a.messageText = "Delete the field “\(name)”?"
    a.informativeText = "Its column goes. Each entry keeps its value in its file, no longer shown."
    let delete = a.addButton(withTitle: "Delete")
    delete.hasDestructiveAction = true
    delete.keyEquivalent = ""
    a.addButton(withTitle: "Cancel").keyEquivalent = "\r"
    return a
  }

  /// A field's header menu: Rename, Delete Field; none for the preset's columns
  func headerMenu(_ column: Int) -> NSMenu? {
    guard let f = field(at: column) else { return nil }
    let m = NSMenu()
    m.addItem(ListMenuItem("Rename") { [weak self] in self?.renameInHeader(f.id) })
    m.addItem(
      ListMenuItem("Delete Field") { [weak self] in
        guard let self else { return }
        fieldTask = Task {
          if await self.confirm(Self.deleteFieldQuestion(f.name), self.window) { self.removeField(f.id) }
        }
      })
    return m
  }

  func tableView(_ tableView: NSTableView, didClick tableColumn: NSTableColumn) {
    guard tableColumn.identifier.rawValue == ListColumn.addID, let i = table.tableColumns.firstIndex(of: tableColumn)
    else { return }
    let r = header.headerRect(ofColumn: i)
    addFieldMenu().popUp(positioning: nil, at: CGPoint(x: r.minX, y: r.maxY), in: header)
  }

  /// The resource file changed and written, and the list read again; false (a beep, said on the bar) when it could not
  /// be
  @discardableResult
  func changeResource(_ change: (inout Resource) -> Void) -> Bool {
    guard let vault = context.pane.vault, let r = resource else { return false }
    do {
      var file = try vault.resource(at: r.path)
      change(&file)
      try vault.write(file, at: r.path)
    } catch {
      failed("The fields could not be changed: \(error)")
      return false
    }
    show(r, tree: nil)
    return true
  }

  // MARK: Options

  /// A new option at the end of a select field's, chosen for the row at `key`; an empty name or one the field has
  /// already is not taken (a beep)
  @discardableResult
  func addOption(_ name: String, to field: String, at key: String) -> Bool {
    let name = name.trimmingCharacters(in: .whitespacesAndNewlines)
    guard let f = fields.first(where: { $0.id == field }), Self.freeName(name, in: f, but: nil) else { return false }
    let o = Resource.Field.Option(id: Board.newID("option-"), name: name)
    guard
      changeResource({ r in
        for i in r.fields.indices where r.fields[i].id == field {
          r.fields[i].options = (r.fields[i].options ?? []) + [o]
        }
      })
    else { return false }
    return set(.text(o.id), of: field, at: key)
  }

  @discardableResult
  func renameOption(_ option: String, of field: String, to name: String) -> Bool {
    let name = name.trimmingCharacters(in: .whitespacesAndNewlines)
    guard let f = fields.first(where: { $0.id == field }), Self.freeName(name, in: f, but: option) else { return false }
    return changeResource { r in
      for i in r.fields.indices where r.fields[i].id == field {
        for j in r.fields[i].options?.indices ?? 0..<0 where r.fields[i].options?[j].id == option {
          r.fields[i].options?[j].name = name
        }
      }
    }
  }

  /// Whether an option may be called `name`: not empty, no other option of the field's called so; a beep when not
  private static func freeName(_ name: String, in f: Resource.Field, but option: String?) -> Bool {
    let free = !name.isEmpty && !(f.options ?? []).contains { $0.name == name && $0.id != option }
    if !free { NSSound.beep() }
    return free
  }

  /// The menu a select or board cell shows: the options (a dot of each's colour) or the boards in tree order, the one
  /// chosen checked; a select's New Option… and Rename of the one chosen; Clear
  func valueMenu(_ f: Resource.Field, at key: String) -> NSMenu {
    let m = NSMenu()
    let now = rows.first { $0.key == key }?.fields[f.id]
    let choices: [(id: String, title: String)] =
      f.type == .select ? (f.options ?? []).map { ($0.id, $0.name) } : boardList.map { ($0.id.rawValue, $0.title) }
    for (i, c) in choices.enumerated() {
      let item = ListMenuItem(c.title) { [weak self] in self?.set(.text(c.id), of: f.id, at: key) }
      item.state = now == .text(c.id) ? .on : .off
      if f.type == .select { item.image = Self.dot(ListColumn.tint(f.options![i].color, at: i)) }
      m.addItem(item)
    }
    if !choices.isEmpty { m.addItem(.separator()) }
    if f.type == .select {
      m.addItem(
        ListMenuItem("New Option…") { [weak self] in
          guard let self else { return }
          fieldTask = Task {
            if let name = await self.askName("New Option", "", self.window) { self.addOption(name, to: f.id, at: key) }
          }
        })
      if let id = now?.text, let o = f.options?.first(where: { $0.id == id }) {
        m.addItem(
          ListMenuItem("Rename “\(o.name)”…") { [weak self] in
            guard let self else { return }
            fieldTask = Task {
              if let name = await self.askName("Rename Option", o.name, self.window) {
                self.renameOption(o.id, of: f.id, to: name)
              }
            }
          })
      }
    }
    let clear = ListMenuItem("Clear") { [weak self] in self?.set(nil, of: f.id, at: key) }
    clear.isEnabled = now != nil
    m.autoenablesItems = false
    m.addItem(clear)
    return m
  }

  private static func dot(_ color: NSColor) -> NSImage {
    NSImage(size: CGSize(width: 10, height: 10), flipped: false) { r in
      color.withAlphaComponent(min(1, color.alphaComponent * 2)).setFill()
      NSBezierPath(ovalIn: r.insetBy(dx: 1, dy: 1)).fill()
      return true
    }
  }

  /// A name asked for in a small alert: OK takes what is typed, Cancel nothing
  static func askNameAlert(_ title: String, _ name: String, in window: NSWindow?) async -> String? {
    let a = NSAlert()
    a.messageText = title
    let field = NSTextField(string: name)
    field.frame = CGRect(x: 0, y: 0, width: 220, height: 22)
    a.accessoryView = field
    a.addButton(withTitle: "OK")
    a.addButton(withTitle: "Cancel")
    a.window.initialFirstResponder = field
    let answer = if let window { await a.beginSheetModal(for: window) } else { a.runModal() }
    return answer == .alertFirstButtonReturn ? field.stringValue : nil
  }

  // MARK: Values

  /// A cell's click, double-click or Return taken when its column is a field's (ListTable.onEdit): a select or board
  /// shows its menu, a checkbox toggles on Return, a text, number or date is typed over (not on a single click)
  func edit(row: Int, column: Int, click: Bool) -> Bool {
    guard let f = field(at: column), shown.indices.contains(row) else { return false }
    let key = shown[row].key
    switch f.type {
    case .select, .board:
      let r = table.frameOfCell(atColumn: column, row: row)
      valueMenu(f, at: key).popUp(positioning: nil, at: CGPoint(x: r.minX + 4, y: r.maxY), in: table)
    case .checkbox:
      if !click { set(.bool(shown[row].fields[f.id] != .bool(true)), of: f.id, at: key) }
    case .text, .number, .date:
      if click { return false }
      type(in: table, over: table.frameOfCell(atColumn: column, row: row), f.typing(shown[row].fields[f.id])) {
        [weak self] in self?.commit($0, of: f.id, at: key) ?? false
      }
    }
    return true
  }

  /// What was typed in a cell of the field, taken as its value (nothing: cleared); not one of its values (a number
  /// that is none, a day not `YYYY-MM-DD`): a beep, nothing written
  @discardableResult
  func commit(_ text: String, of field: String, at key: String) -> Bool {
    guard let f = fields.first(where: { $0.id == field }), let v = f.typed(text) else {
      NSSound.beep()
      return false
    }
    return set(v, of: field, at: key)
  }

  /// The row at `key`'s value for the field set (nil: cleared): its entry file read and written again, a file alone
  /// made an entry first; that row alone read again, still selected
  @discardableResult
  func set(_ value: Entry.Value?, of field: String, at key: String) -> Bool {
    guard let vault = context.pane.vault, let i = rows.firstIndex(where: { $0.key == key }),
      rows[i].kind != "Unreadable"
    else {
      NSSound.beep()
      return false
    }
    var path = key
    let entry: Entry
    if rows[i].id == nil {
      guard let made = promoted(key, fields: value.map { [field: $0] } ?? [:]) else {
        NSSound.beep()
        return false
      }
      (entry, path) = made
    } else {
      do {
        var e = try vault.entry(at: key)
        e.fields[field] = value
        try vault.write(e, at: key)
        entry = e
      } catch {
        failed("The value could not be saved: \(error)")
        return false
      }
      context.pane.entries.update(entry, at: path)
    }
    rows[i] = decorated(ListRow(.entry(entry, path: path), vault: vault))
    reload(moved: (key, path))
    return true
  }

  // MARK: Typing

  /// A text field over `frame` of `view` with `text`, taking the keyboard: Return commits (`commit` false: a beep, it
  /// stays), Esc cancels, leaving it commits what it can
  func type(in view: NSView, over frame: CGRect, _ text: String, commit: @escaping (String) -> Bool) {
    endTyping()
    let field = NSTextField(string: text)
    field.font = .systemFont(ofSize: 12)
    field.frame = frame.insetBy(dx: 4, dy: max(0, (frame.height - 20) / 2))
    field.delegate = self
    view.addSubview(field)
    typing = (field, commit)
    window?.makeFirstResponder(field)
  }

  /// The typing field gone, the table given the keyboard back
  func endTyping() {
    guard let t = typing else { return }
    typing = nil
    t.field.removeFromSuperview()
    if window?.firstResponder == nil || window?.firstResponder === window { window?.makeFirstResponder(table) }
  }

  /// A field's name typed over its header
  func renameInHeader(_ id: String) {
    guard let i = table.tableColumns.firstIndex(where: { $0.identifier.rawValue == "field:" + id }),
      let f = fields.first(where: { $0.id == id })
    else { return }
    table.scrollColumnToVisible(i)
    type(in: header, over: header.headerRect(ofColumn: i), f.name) { [weak self] in
      self?.renameField(id, to: $0) ?? false
    }
  }
}

extension ListTabView: NSTextFieldDelegate {
  func control(_ control: NSControl, textView: NSTextView, doCommandBy selector: Selector) -> Bool {
    guard let t = typing, control === t.field else { return false }
    switch selector {
    case #selector(NSResponder.cancelOperation(_:)):
      endTyping()
    case #selector(NSResponder.insertNewline(_:)):
      if t.commit(t.field.stringValue) { endTyping() }
    default:
      return false
    }
    return true
  }

  /// Left for elsewhere: what was typed committed when it can be
  func controlTextDidEndEditing(_ note: Notification) {
    guard let t = typing, note.object as AnyObject === t.field else { return }
    typing = nil
    _ = t.commit(t.field.stringValue)
    t.field.removeFromSuperview()
  }
}
