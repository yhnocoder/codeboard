import AppKit
import CodeBoardModel
import CodeBoardResources

// A row dragged out of the list onto a board: a paper or a PDF becomes an ordinary Note of its title in bold and its
// authors under it, its source the entry as a whole (no place); a web page its address, which the board makes the Web
// card a pasted address makes. A PDF that is a file alone becomes an entry first, as its PDF tab makes it one when
// collecting from it. Files that are neither, and unreadable ones, are not dragged.

extension ListRow {
  /// What dragging it carries; nil: it is not dragged (a file, an unreadable item, a PDF not yet an entry)
  var dragItem: NSPasteboardItem? {
    let item = NSPasteboardItem()
    if let address {
      item.setString(address.absoluteString, forType: .URL)
      item.setString(address.absoluteString, forType: .string)
      return item
    }
    // an entry of files alone is no paper; one with nothing yet (its title and authors) is
    guard let id, kind != "File", let data = try? collected(id).data() else { return nil }
    item.setData(data, forType: .collected)
    item.setString(title, forType: .string)
    return item
  }

  /// The Note a paper or a PDF becomes: the title in bold, the authors on the line under it
  func collected(_ id: EntryID) -> Collected {
    let byline = authors.isEmpty ? "" : "\n" + Self.literal(authors.joined(separator: ", "))
    return Collected(
      body: .note(markdown: "**\(Self.literal(title))**" + byline), source: SourceAnchor(entry: id, place: nil),
      title: title, label: "")
  }

  /// `s` as Markdown that shows it as it is: the characters that would start emphasis, code, math, a highlight, a link,
  /// a reference, HTML or an entity escaped
  static func literal(_ s: String) -> String {
    let special = Set("\\`*_[]{}<>#$&|~=^")
    return s.reduce(into: "") { out, c in
      if special.contains(c) { out.append("\\") }
      out.append(c)
    }
  }
}

extension ListTabView {
  func tableView(_ tableView: NSTableView, pasteboardWriterForRow row: Int) -> (any NSPasteboardWriting)? {
    guard shown.indices.contains(row) else { return nil }
    var r = shown[row]
    if r.id == nil, case .pdf(.file(let path))? = r.opens { r.id = promoted(path)?.entry.id }
    return r.dragItem
  }

  /// The list read again once a drag from it is over: a PDF made an entry by it shows as one
  func tableView(
    _ tableView: NSTableView, draggingSession session: NSDraggingSession, endedAt screenPoint: NSPoint,
    operation: NSDragOperation
  ) {
    let (r, tree) = ListReading.resource(context.payload, in: context.pane.vault)
    show(r, tree: tree)
  }

  /// A file alone made an entry of the same name with `fields`, a PDF as its PDF tab makes it (PDFTabView.madeEntry),
  /// any other file a version that is the file; nil when it cannot be: a tab has it open as a file (that tab
  /// would lose it), or it could not be moved. The entry and its folder's path
  func promoted(_ path: String, fields: [String: Entry.Value] = [:]) -> (entry: Entry, path: String)? {
    guard let vault = context.pane.vault, !context.pane.tabs.contains(where: { $0.key == PDFTarget.file(path).key })
    else { return nil }
    let name = (path as NSString).lastPathComponent
    let file = Vault.plainFileName(name)
    let now = Entry.now
    let e = Entry(
      id: EntryID(rawValue: Board.newID("e")), title: (name as NSString).deletingPathExtension, added: now,
      versions: [
        Version(
          id: VersionID(rawValue: Board.newID("v")), added: now,
          content: (name as NSString).pathExtension.lowercased() == "pdf" ? .pdf(file: file) : .file(file))
      ], fields: fields)
    guard let at = try? vault.promote(file: path, to: e, as: file) else {
      NSSound.beep()
      return nil
    }
    context.pane.entries.update(e, at: at)
    return (e, at)
  }
}
