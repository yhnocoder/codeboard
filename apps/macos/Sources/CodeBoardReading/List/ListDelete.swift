import AppKit
import CodeBoardModel
import CodeBoardResources

// The selected rows deleted (⌫, the row menu's Delete, Edit ▸ Delete): each item's folder or file to the Trash, as the
// sidebar deletes a board or a resource (Vault.trash; Finder puts it back, there is no undo in the app). Entries with
// cards on boards are asked about first, naming the boards; the cards keep what they hold (a Note's text is the
// board's), and their source line says the source is not found.

extension ListTabView {
  @objc func delete(_ sender: Any?) {
    let rows = table.selectedRowIndexes.filter(shown.indices.contains).map { shown[$0] }
    guard !rows.isEmpty, let vault = context.pane.vault, let tree = try? vault.tree() else { return NSSound.beep() }
    deleting = Task { [weak self] in
      // looked up now, not taken from the column, which may not be read yet
      let found = await EntryBoards.shared.lookup(vault, tree.allBoards)
      // ponytail: boards known by title alone, so two boards of one name are named once
      var seen = Set<String>()
      let boards = rows.compactMap(\.id).flatMap { found[$0] ?? [] }.filter { seen.insert($0).inserted }
      guard let self else { return }
      if !boards.isEmpty, !(await confirm(Self.deleteQuestion(rows.map(\.title), boards: boards), window)) { return }
      trash(rows.map(\.key))
    }
  }

  /// The question before entries used on boards are deleted: on how many boards, the first six named; Cancel is the
  /// default button, Delete the first
  static func deleteQuestion(_ titles: [String], boards: [String]) -> NSAlert {
    let on = boards.count == 1 ? "1 board" : "\(boards.count) boards"
    let a = NSAlert()
    a.alertStyle = .warning
    a.messageText = titles.count == 1 ? "“\(titles[0])” is used on \(on)" : "\(titles.count) entries are used on \(on)"
    let names = boards.prefix(6).joined(separator: ", ") + (boards.count > 6 ? " and \(boards.count - 6) more" : "")
    a.informativeText =
      "Used on: \(names).\n\n\(titles.count == 1 ? "It goes" : "They go") to the Trash. Notes on these boards keep their "
      + "text, with their source shown as not found; pictures collected from \(titles.count == 1 ? "it" : "them") are no longer shown."
    let delete = a.addButton(withTitle: "Delete")
    delete.hasDestructiveAction = true
    delete.keyEquivalent = ""
    a.addButton(withTitle: "Cancel").keyEquivalent = "\r"
    return a
  }

  /// The question as a sheet on the window (alone when there is none); whether Delete was pressed
  static func ask(_ alert: NSAlert, in window: NSWindow?) async -> Bool {
    let answer = if let window { await alert.beginSheetModal(for: window) } else { alert.runModal() }
    return answer == .alertFirstButtonReturn
  }

  /// Each item to the trash, stopping at the first that cannot go (a beep, said on the bar); then the entries and the
  /// list read again
  func trash(_ paths: [String]) {
    guard let vault = context.pane.vault else { return }
    say(nil)
    for p in paths {
      do { try vault.trash(p, with: trasher) } catch {
        failed("“\((p as NSString).lastPathComponent)” could not be deleted: \(error)")
        break
      }
    }
    let (r, tree) = ListReading.resource(context.payload, in: vault)
    if let tree { context.pane.entries = EntryIndex(vault, tree) }
    show(r, tree: tree)
  }
}
