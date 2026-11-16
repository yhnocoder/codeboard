import AppKit
import CodeBoardModel
import CodeBoardResources
import Foundation
import Testing

@testable import CodeBoardReading

private typealias Field = Resource.Field
private let at = URL(filePath: "/vault/R.resource/resource.json")

private func resource(_ fields: String) throws -> Resource {
  try Resource(decoding: Data(#"{"version": 1, "id": "r", "preset": "blank", "fields": \#(fields)}"#.utf8), file: at)
}

@MainActor private func cell(_ list: ListTabView, _ f: Field, _ row: Int) throws -> ListCell {
  let c = list.table.column(withIdentifier: NSUserInterfaceItemIdentifier("field:" + f.id))
  let cell = try #require(list.table.view(atColumn: c, row: row, makeIfNecessary: true) as? ListCell)
  cell.layoutSubtreeIfNeeded()
  return cell
}

@MainActor private func key(_ list: ListTabView, _ title: String) throws -> String {
  try #require(list.rows.first { $0.title == title }).key
}

@MainActor private func row(_ list: ListTabView, _ title: String) throws -> Int {
  try #require(list.shown.firstIndex { $0.title == title })
}

@MainActor @Suite(.serialized) struct ListFieldsTests {
  /// A select's options with their ids, names and colours, a board field, and the old kinds without options
  @Test func fieldsOfEveryKindRoundTripWithSelectOptionsAndTheirColours() throws {
    let r = Resource(
      id: ResourceID(rawValue: "r"), preset: .blank,
      fields: [
        Field(
          id: "s", name: "Stage", type: .select,
          options: [.init(id: "option-a", name: "Draft", color: .green), .init(id: "option-b", name: "Done")]),
        Field(id: "e", name: "Empty", type: .select),
        Field(id: "b", name: "Board", type: .board),
        Field(id: "t", name: "Notes", type: .text),
      ])
    let data = try r.encoded()
    #expect(try Resource(decoding: data, file: at) == r)
    let json = try #require(try JSONSerialization.jsonObject(with: data) as? [String: Any])
    let fields = try #require(json["fields"] as? [[String: Any]])
    #expect(
      fields[0]["options"] as? [[String: String]] == [
        ["id": "option-a", "name": "Draft", "color": "green"], ["id": "option-b", "name": "Done"],
      ])
    #expect(fields[1]["options"] as? [Any] != nil && (fields[1]["options"] as? [Any])?.isEmpty == true)
    #expect(fields[2]["options"] == nil && fields[3]["options"] == nil)
    // a file from before select and board, as it was
    let old = try resource(#"[{"id": "a", "name": "A", "type": "text"}, {"id": "c", "name": "C", "type": "checkbox"}]"#)
    #expect(old.fields.map(\.options) == [nil, nil] && old.fields.map(\.type) == [.text, .checkbox])
  }

  @Test func readingRefusesOptionsTheWriterWouldNotWrite() throws {
    let refused: [(String, String)] = [
      (#"[{"id": "s", "name": "S", "type": "select"}]"#, "field s: a select field without its options"),
      (#"[{"id": "t", "name": "T", "type": "text", "options": []}]"#, "field t: options on a text field"),
      (
        #"[{"id": "s", "name": "S", "type": "select", "options": [{"id": "", "name": "A"}]}]"#,
        "field s: an option without its id or name"
      ),
      (
        #"[{"id": "s", "name": "S", "type": "select", "options": [{"id": "o1", "name": "A"}, {"id": "o1", "name": "B"}]}]"#,
        "field s: option o1 is there twice"
      ),
      (
        #"[{"id": "s", "name": "S", "type": "select", "options": [{"id": "o1", "name": "A"}, {"id": "o2", "name": "A"}]}]"#,
        "field s: option name A is there twice"
      ),
    ]
    for (fields, why) in refused {
      #expect(throws: VaultError.malformed(at, why)) { try resource(fields) }
    }
    // a colour that is not a highlight's, a kind this build does not know
    for bad in [
      #"[{"id": "s", "name": "S", "type": "select", "options": [{"id": "o1", "name": "A", "color": "red"}]}]"#,
      #"[{"id": "a", "name": "A", "type": "url"}]"#,
    ] {
      #expect(throws: VaultError.self) { try resource(bad) }
    }
  }

  /// A field added: one more in the file and a column after the preset's (before the +), named for its kind; renamed
  /// from its header, an empty name not taken
  @Test func aFieldAddedIsInTheFileAndAColumnAfterThePresets() async throws {
    let v = try ListVault()
    defer { v.remove() }
    let (_, list) = try await v.openList()
    let f = try #require(list.addField(.text))
    let g = try #require(list.addField(.text))
    #expect(f.name == "Text" && g.name == "Text 2" && f.id != g.id)
    #expect(list.table.tableColumns.map(\.title) == ["Title", "Year", "Boards", "Text", "Text 2", ""])
    #expect(try v.vault.resource(at: v.resource.path).fields == [f, g])
    #expect(list.addFieldMenu().items.map(\.title) == ["Text", "Number", "Date", "Select", "Checkbox", "Board"])
    #expect(list.renameField(f.id, to: " Notes "))
    #expect(!list.renameField(f.id, to: "  "))
    #expect(try v.vault.resource(at: v.resource.path).fields.map(\.name) == ["Notes", "Text 2"])
    #expect(list.table.tableColumns[3].title == "Notes")
    // a field's header has the menu, the preset's columns none
    #expect(list.headerMenu(3)?.items.map(\.title) == ["Rename", "Delete Field"] && list.headerMenu(0) == nil)
  }

  /// Each kind's value written in the entry's file as its kind is, and shown; a value that is not one not written; a
  /// value cleared its key gone
  @Test func eachKindsValueIsWrittenAsItsKindAndClearedByDroppingItsKey() async throws {
    let v = try ListVault()
    defer { v.remove() }
    try v.vault.newBoard(in: "", title: "Alpha", board: Board(id: BoardID(rawValue: "b-a")))
    try await v.treeRead()
    let (_, list) = try await v.openList()
    let kinds: [Field.Kind] = [.text, .number, .date, .checkbox, .select, .board]
    let f = Dictionary(uniqueKeysWithValues: kinds.map { ($0, list.addField($0)!) })
    let k = v.paperPath
    func value(_ kind: Field.Kind) throws -> Entry.Value? { try v.vault.entry(at: k).fields[f[kind]!.id] }
    func shown(_ kind: Field.Kind) throws -> ListCell { try cell(list, f[kind]!, try row(list, "Tidal mills")) }

    #expect(try list.commit("hello", of: f[.text]!.id, at: k) && (value(.text)) == .text("hello"))
    #expect(try !list.commit("many", of: f[.number]!.id, at: k) && (value(.number)) == nil)
    #expect(try list.commit("2.5", of: f[.number]!.id, at: k) && (value(.number)) == .number(2.5))
    #expect(try !list.commit("2024-13-01", of: f[.date]!.id, at: k) && (value(.date)) == nil)
    #expect(try list.commit("2024-03-05", of: f[.date]!.id, at: k) && (value(.date)) == .text("2024-03-05"))
    #expect(try list.set(.bool(true), of: f[.checkbox]!.id, at: k) && (value(.checkbox)) == .bool(true))
    #expect(list.addOption("Draft", to: f[.select]!.id, at: k))
    #expect(!list.addOption("Draft", to: f[.select]!.id, at: k) && !list.addOption("  ", to: f[.select]!.id, at: k))
    let option = try #require(try v.vault.resource(at: v.resource.path).fields.first { $0.type == .select }?.options)
    #expect(option.map(\.name) == ["Draft"] && option[0].id.hasPrefix("option-") && option[0].color == nil)
    #expect(try value(.select) == .text(option[0].id))
    #expect(try list.set(.text("b-a"), of: f[.board]!.id, at: k) && (value(.board)) == .text("b-a"))
    // the file says each as its kind: a number, a string, true
    let raw = try JSONSerialization.jsonObject(with: Data(contentsOf: v.vault.url(of: "\(k)/entry.json")))
    let fields = try #require((raw as? [String: Any])?["fields"] as? [String: Any])
    #expect(fields[f[.number]!.id] as? Double == 2.5 && fields[f[.checkbox]!.id] as? Bool == true)

    #expect(try shown(.text).line.stringValue == "hello" && (try shown(.number)).line.stringValue == "2.5")
    let day = ListColumn.day(try #require(ListColumn.isoDay("2024-03-05")))
    #expect(try shown(.date).line.stringValue == day)
    #expect(try shown(.checkbox).check.state == .on && (try shown(.checkbox)).line.isHidden)
    #expect(try shown(.select).line.stringValue == "Draft" && !(try shown(.select)).pill.isHidden)
    #expect(try shown(.board).line.stringValue == "Alpha")
    #expect(
      list.valueMenu(list.fields.first { $0.type == .select }!, at: k).items.map(\.title) == [
        "Draft", "", "New Option…", "Rename “Draft”…", "Clear",
      ])
    #expect(list.valueMenu(f[.board]!, at: k).items.map(\.title) == ["Alpha", "", "Open Board", "Clear"])

    #expect(try list.commit("", of: f[.text]!.id, at: k) && (value(.text)) == nil)
    #expect(try list.set(nil, of: f[.select]!.id, at: k) && (value(.select)) == nil)
    #expect(
      try v.vault.entry(at: k).fields.keys.sorted() == [.number, .date, .checkbox, .board].map { f[$0]!.id }.sorted())
  }

  /// A double-click's typing over a cell: Return commits (a number that is none stays, not written), Esc cancels; a
  /// checkbox toggles on its click
  @Test func valuesTypedOverTheirCellAndCheckboxesClicked() async throws {
    let v = try ListVault()
    defer { v.remove() }
    let (_, list) = try await v.openList()
    let n = try #require(list.addField(.number))
    let c = try #require(list.addField(.checkbox))
    let column = list.table.column(withIdentifier: NSUserInterfaceItemIdentifier("field:" + n.id))
    let r = try row(list, "Tidal mills")
    func press(_ s: Selector) throws {
      let t = try #require(list.typing)
      _ = list.control(t.field, textView: NSTextView(), doCommandBy: s)
    }
    #expect(list.edit(row: r, column: column, click: false) && list.typing?.field.superview === list.table)
    list.typing?.field.stringValue = "twelve"
    try press(#selector(NSResponder.insertNewline(_:)))
    #expect(try list.typing != nil && v.vault.entry(at: v.paperPath).fields.isEmpty)
    list.typing?.field.stringValue = "12"
    try press(#selector(NSResponder.insertNewline(_:)))
    #expect(try list.typing == nil && v.vault.entry(at: v.paperPath).fields == [n.id: .number(12)])
    #expect(list.edit(row: r, column: column, click: false) && list.typing?.field.stringValue == "12")
    list.typing?.field.stringValue = "13"
    try press(#selector(NSResponder.cancelOperation(_:)))
    #expect(try list.typing == nil && v.vault.entry(at: v.paperPath).fields == [n.id: .number(12)])
    // the title column is not a field's: a double-click there opens the row
    #expect(!list.edit(row: r, column: 0, click: false))

    try cell(list, c, r).check.performClick(nil)
    #expect(try v.vault.entry(at: v.paperPath).fields[c.id] == .bool(true))
    try cell(list, c, try row(list, "Tidal mills")).check.performClick(nil)
    #expect(try v.vault.entry(at: v.paperPath).fields[c.id] == .bool(false))
  }

  /// A file that is an entry alone given a value becomes an entry with it, its row still selected under its new key
  @Test func aFileAloneGivenAValueBecomesAnEntryAndStaysSelected() async throws {
    let v = try ListVault()
    defer { v.remove() }
    let (_, list) = try await v.openList()
    let f = try #require(list.addField(.text))
    let file = try key(list, "Pier notes")
    list.select(try row(list, "Pier notes"))
    #expect(list.commit("to read", of: f.id, at: file))
    let now = try #require(list.selected.map { list.shown[$0] })
    #expect(now.title == "Pier notes" && now.key != file && now.id != nil)
    let e = try v.vault.entry(at: now.key)
    #expect(e.fields == [f.id: .text("to read")] && e.versions.count == 1)
    guard case .pdf(let name, _, _) = e.versions.first?.content else {
      Issue.record("not a PDF version")
      return
    }
    #expect(FileManager.default.fileExists(atPath: v.vault.url(of: "\(now.key)/\(name)").path))
  }

  /// A field deleted (asked first, from its header): its column gone, its values still in the entries' files
  @Test func aDeletedFieldsValuesStayInTheEntryFiles() async throws {
    let v = try ListVault()
    defer { v.remove() }
    let (_, list) = try await v.openList()
    let f = try #require(list.addField(.number))
    #expect(list.commit("7", of: f.id, at: v.paperPath))
    var asked: NSAlert?
    list.confirm = { a, _ in
      asked = a
      return true
    }
    let menu = try #require(list.headerMenu(3))
    menu.performActionForItem(at: 1)
    await list.fieldTask?.value
    #expect(asked?.messageText == "Delete the field “Number”?")
    #expect(try v.vault.resource(at: v.resource.path).fields.isEmpty)
    #expect(list.table.tableColumns.map(\.title) == ["Title", "Year", "Boards", ""])
    #expect(try v.vault.entry(at: v.paperPath).fields == [f.id: .number(7)])
  }

  /// A field's header sorts by it, values first either way and the rows without one after; a select by its options'
  /// order
  @Test func sortingByAFieldPutsRowsWithoutAValueLast() async throws {
    let v = try ListVault()
    defer { v.remove() }
    let (_, list) = try await v.openList()
    let n = try #require(list.addField(.number))
    for (title, value) in [("Weirs", "3"), ("Estuary flows", "-1"), ("Tidal mills", "20")] {
      #expect(list.commit(value, of: n.id, at: try key(list, title)))
    }
    func sorted(_ f: Field, up: Bool) -> [String] {
      list.table.sortDescriptors = [NSSortDescriptor(key: "field:" + f.id, ascending: up)]
      return list.shown.map(\.title)
    }
    let rest = ["Harbour log", "Pier notes", "Quay plans"]
    #expect(sorted(n, up: true) == ["Estuary flows", "Weirs", "Tidal mills"] + rest)
    #expect(sorted(n, up: false) == ["Tidal mills", "Weirs", "Estuary flows"] + rest)

    let s = try #require(list.addField(.select))
    #expect(list.addOption("Later", to: s.id, at: try key(list, "Quay plans")))
    #expect(list.addOption("Sooner", to: s.id, at: try key(list, "Harbour log")))
    let later = try #require(list.fields.first { $0.id == s.id }?.options?.first)
    #expect(list.set(.text(later.id), of: s.id, at: try key(list, "Weirs")))
    #expect(sorted(s, up: true).prefix(3) == ["Quay plans", "Weirs", "Harbour log"])
  }

  /// An option renamed: the values naming it show its new name; one gone from the options: kept, shown as deleted
  @Test func optionsRenamedOrGoneShowAsTheyAreNow() async throws {
    let v = try ListVault()
    defer { v.remove() }
    let (_, list) = try await v.openList()
    let s = try #require(list.addField(.select))
    let k = v.paperPath
    let weirs = try key(list, "Weirs")
    #expect(list.addOption("Draft", to: s.id, at: k) && list.addOption("Done", to: s.id, at: weirs))
    let options = try #require(list.fields.first?.options)
    #expect(!list.renameOption(options[0].id, of: s.id, to: "Done"))
    #expect(list.renameOption(options[0].id, of: s.id, to: "Final"))
    #expect(try cell(list, s, try row(list, "Tidal mills")).line.stringValue == "Final")
    #expect(try v.vault.entry(at: k).fields[s.id] == .text(options[0].id))
    list.changeResource { $0.fields[0].options = [options[1]] }
    let gone = try cell(list, s, try row(list, "Tidal mills"))
    #expect(gone.line.stringValue == "deleted option" && gone.pill.isHidden)
    #expect(try v.vault.entry(at: k).fields[s.id] == .text(options[0].id))
  }

  @Test func aBoardThatIsGoneShowsAsNotFound() async throws {
    let v = try ListVault()
    defer { v.remove() }
    let (_, list) = try await v.openList()
    let b = try #require(list.addField(.board))
    #expect(list.set(.text("b-gone"), of: b.id, at: v.paperPath))
    #expect(try cell(list, b, try row(list, "Tidal mills")).line.stringValue == "Not found")
    #expect(try v.vault.entry(at: v.paperPath).fields[b.id] == .text("b-gone"))
  }

  /// A board value's Open Board and ⌘-click show its board through the pane; with no value, or a board that is gone,
  /// Open Board cannot be chosen and a ⌘-click is not taken
  @Test func openBoardShowsTheBoardTheValueNames() async throws {
    let v = try ListVault()
    defer { v.remove() }
    try v.vault.newBoard(in: "", title: "Alpha", board: Board(id: BoardID(rawValue: "b-a")))
    try await v.treeRead()
    let (_, list) = try await v.openList()
    var opened: [BoardID] = []
    v.pane.onOpenBoard = { opened.append($0) }
    let b = try #require(list.addField(.board))
    let k = v.paperPath
    func openItem() throws -> NSMenuItem {
      try #require(list.valueMenu(b, at: k).items.first { $0.title == "Open Board" })
    }
    let column = try #require(list.table.tableColumns.firstIndex { $0.identifier.rawValue == "field:" + b.id })

    #expect(try !openItem().isEnabled && !list.commandClick(row: try row(list, "Tidal mills"), column: column))
    #expect(list.set(.text("b-gone"), of: b.id, at: k))
    #expect(try !openItem().isEnabled && !list.commandClick(row: try row(list, "Tidal mills"), column: column))
    #expect(list.set(.text("b-a"), of: b.id, at: k))
    let menu = list.valueMenu(b, at: k)
    let i = menu.indexOfItem(withTitle: "Open Board")
    #expect(i >= 0 && menu.items[i].isEnabled)
    menu.performActionForItem(at: i)
    #expect(opened == [BoardID(rawValue: "b-a")])
    #expect(list.commandClick(row: try row(list, "Tidal mills"), column: column))
    #expect(opened == [BoardID(rawValue: "b-a"), BoardID(rawValue: "b-a")])
  }
}
