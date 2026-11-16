import AppKit
import CodeBoardModel
import CodeBoardReading
import CodeBoardResources
import UniformTypeIdentifiers

// The sidebar's changes to the vault's files (VaultFiles.swift does each one): what open boards have not written yet is
// written first, then the one rename or new name, then the tree is read again at once, so tabs and documents follow
// (they hold boards by id) and expanded folders keep their state under their new path. Nothing is ever written over;
// deleting moves to the system Trash.

extension Shell {
  /// A menu item; nil: a separator
  public typealias MenuEntry = (title: String, run: () -> Void)?

  /// A folder's row menu
  public func menu(folder: VaultFolder) -> [MenuEntry] {
    var m: [MenuEntry] = [
      ("New Board", { self.newBoard(in: folder.path) }), ("New Folder", { self.newFolder(in: folder.path) }),
      ("New Resource", { self.newResource(in: folder.path) }), nil,
      ("Rename", { self.renaming = .folder(folder.path) }), nil,
    ]
    if let own = folder.folderBoard {
      m.append(("Delete Folder Board", { self.trashAsked(own.path, self.boardQuestion(own)) }))
    }
    m.append(
      (
        "Delete Folder",
        {
          let resources = folder.allFolders.reduce(0) { $0 + $1.resources.count + $1.unreadableResources.count }
          self.trashAsked(
            folder.path, BoardPanes.deleteFolderQuestion(folder.name, boards: folder.boardCount, resources: resources))
        }
      ))
    return m
  }

  /// A board's row menu
  public func menu(board: VaultBoard) -> [MenuEntry] {
    [
      ("Rename", { self.renaming = .board(board.id) }), ("Edit Mark…", { self.sealEditing = board.id }),
      ("Duplicate Board", { self.duplicate(board) }),
      // the sidebar shows moveTargets(board:) under it
      ("Move to", {}), nil,
    ] + fileEntries(board.path, Vault.boardFileName) + [
      nil, ("Delete", { self.trashAsked(board.path, self.boardQuestion(board)) }),
    ]
  }

  /// A resource's row menu: what a board's has that a resource has too, and adding PDFs and papers (by arXiv id or
  /// DOI) to it
  public func menu(resource: VaultResource) -> [MenuEntry] {
    let n = resource.entryCount
    return [
      ("Add PDF…", { Task { self.addPDFs(await self.askPDFs(), to: resource) } }),
      ("Add arXiv or DOI Paper…", { self.askArxiv(resource) }), nil,
      ("Rename", { self.renaming = .resource(resource.id) }), ("Move to", {}), nil,
    ]
      + fileEntries(resource.path, Vault.resourceFileName) + [
        nil,
        (
          "Delete",
          {
            self.trashAsked(
              resource.path,
              BoardPanes.destroying(
                "Delete resource “\(resource.title)”?",
                n == 1 ? "Its 1 entry goes to the Trash with it." : "Its \(n) entries go to the Trash with it.",
                "Delete"))
          }
        ),
      ]
  }

  /// Duplicate Board: a copy beside it in its folder (VaultFiles duplicateBoard), not opened (host actions.ts)
  public func duplicate(_ board: VaultBoard) {
    files { v in try v.duplicateBoard(at: board.path) }
  }

  /// Move to ▸ (host actions.ts moveToGroup, with the vault's folders for its groups): the top level and every folder,
  /// `Parent › Child`, but the one it is in
  public func moveTargets(board: VaultBoard) -> [(title: String, run: () -> Void)] { moveTargets(board.path) }

  public func moveTargets(resource: VaultResource) -> [(title: String, run: () -> Void)] { moveTargets(resource.path) }

  private func moveTargets(_ from: String) -> [(title: String, run: () -> Void)] {
    guard let tree else { return [] }
    let here = from.split(separator: "/").dropLast().joined(separator: "/")
    let all = [("", "Top Level")] + tree.allFolders.dropFirst().map { ($0.path, $0.path.replacing("/", with: " › ")) }
    return all.filter { $0.0 != here }.map { path, title in (title, { _ = self.move(from, into: path) }) }
  }

  /// The row of a board or resource that cannot be read: shown in Finder, its file's path copied, or deleted
  public func menu(unreadable b: VaultUnreadable) -> [MenuEntry] {
    let resource = (b.path as NSString).pathExtension == Vault.resourceExtension
    return fileEntries(b.path, resource ? Vault.resourceFileName : Vault.boardFileName) + [
      nil,
      (
        "Delete",
        {
          self.trashAsked(
            b.path,
            BoardPanes.destroying(
              "Delete \(resource ? "resource" : "board") “\(b.title)”?",
              "Its file cannot be read. It goes to the Trash.",
              "Delete"))
        }
      ),
    ]
  }

  /// Reveal in Finder and Copy Path (host commands.ts revealInFolder, copyBoardPath: the path of the package's `file`,
  /// said nothing about)
  private func fileEntries(_ path: String, _ file: String) -> [MenuEntry] {
    guard let vault else { return [] }
    let package = vault.url(of: path)
    return [
      ("Reveal in Finder", { NSWorkspace.shared.activateFileViewerSelecting([package]) }),
      (
        "Copy Path",
        {
          self.pasteboard.clearContents()
          self.pasteboard.setString(
            package.appending(path: file).path(percentEncoded: false), forType: .string)
        }
      ),
    ]
  }

  /// Asked first, as main's sidebar asks (host handlers.ts deleteBoardAsked, actions.ts deleteGroup), then to the Trash
  private func trashAsked(_ path: String, _ question: NSAlert) {
    Task { if await confirm(question) { trash(path) } }
  }

  private func boardQuestion(_ b: VaultBoard) -> NSAlert {
    BoardPanes.deleteQuestion(b.title, cards: (try? vault?.board(at: b.path).cards.count) ?? 0)
  }

  /// What `hoveredRow` names
  public static func rowKey(folder path: String) -> String { "folder:" + path }
  public static func rowKey(board id: BoardID) -> String { "board:" + id.rawValue }

  /// Runs a change to the vault's files; whether it went through (a name taken: nothing changed, a beep)
  @discardableResult
  func files(_ change: (Vault) throws -> Void) -> Bool {
    guard let vault else { return false }
    beforeFiles?()
    var ok = true
    fileError = nil
    do { try change(vault) } catch {
      ok = false
      fileError = String(describing: error)
      NSSound.beep()
    }
    apply(Result { try vault.tree() })
    afterFiles?()
    return ok
  }

  /// A new empty board in `folder`, shown, its name written in place
  public func newBoard(in folder: String) {
    var made: VaultBoard?
    files { v in made = try v.newBoard(in: folder, title: v.freeName(in: folder, "New Board", package: true)) }
    guard let made else { return }
    if !folder.isEmpty { expanded.insert(folder) }
    show(made.id)
    renaming = .board(made.id)
  }

  /// A new resource in `folder`, a list of files to begin with, its tab opened, its name written in place
  public func newResource(in folder: String) {
    var made: VaultResource?
    files { v in
      made = try v.newResource(
        in: folder, title: v.freeName(in: folder, "New Resource", extension: Vault.resourceExtension), preset: .files)
    }
    guard let made else { return }
    if !folder.isEmpty { expanded.insert(folder) }
    openResource(made)
    renaming = .resource(made.id)
  }

  /// PDF files (chosen in Add PDF…'s panel, or dropped on the resource's row) copied into the resource, each an entry
  /// alone under a name nothing there has, never over anything, then opened in the reading pane; whether any was
  @discardableResult
  public func addPDFs(_ urls: [URL], to resource: VaultResource) -> Bool {
    let pdfs = urls.filter { UTType(filenameExtension: $0.pathExtension)?.conforms(to: .pdf) == true }
    guard !pdfs.isEmpty else { return false }
    var added: [String] = []
    files { v in
      for url in pdfs { added.append(try v.addFile(url, to: resource.path)) }
    }
    for path in added { openPDF(.file(path)) }
    return !added.isEmpty
  }

  /// Add arXiv or DOI Paper…'s Add: the paper `text` names (an arXiv id or address, or a DOI) added to `resource`. One
  /// the vault has an entry for is that entry, opened at the version asked for (else its newest), never a second
  /// entry; else its metadata (and an arXiv paper's PDF) come from arXiv (`reading.arxiv`) or doi.org (`reading.doi`)
  /// and make a new entry of `resource`. An arXiv paper opens in a PDF tab, `translate`: that version's translation
  /// queued too; a DOI's entry has no PDF, so its resource's list opens. Nil when it went through, else what went wrong
  /// in plain words
  public func addPaper(_ text: String, translate: Bool, to resource: VaultResource) async -> String? {
    guard vault != nil else { return "No vault is open." }
    switch PaperID.parse(text) {
    case .arxiv(let id, let asked)?: return await addArxiv(id, asked, translate: translate, to: resource)
    case .doi(let doi)?: return await addDOI(doi, to: resource)
    case nil: return "“\(text)” is not an arXiv id, a DOI or an address of either."
    }
  }

  private func addArxiv(_ id: String, _ asked: Int?, translate: Bool, to resource: VaultResource) async -> String? {
    if let found = reading.entries.arxiv(id) {
      let originals = found.entry.versions.filter { $0.of == nil }
      guard
        let v = originals.first(where: { asked != nil && Arxiv.number($0) == asked })
          ?? originals.max(by: { (Arxiv.number($0) ?? 0) < (Arxiv.number($1) ?? 0) })
      else { return "\(found.entry.title) has no version to open." }
      openPDF(.entry(found.entry.id, version: v.id))
      if translate, !found.entry.versions.contains(where: { $0.of == v.id }) { queueTranslation(found.entry, v) }
      return nil
    }
    let arxiv = reading.arxiv
    let made: (Entry, String)
    do {
      let paper = try await arxiv.paper(id)
      let n = asked ?? paper.latest
      let pdf = try await arxiv.pdf(id, version: n)
      var out: (Entry, String)?
      guard files({ v in out = try v.newEntry(paper, version: n, pdf: pdf, in: resource.path) }), let out else {
        return fileError ?? "The paper could not be added."
      }
      made = out
    } catch {
      return error.description
    }
    openPDF(.entry(made.0.id, version: made.0.versions[0].id))
    if translate { queueTranslation(made.0, made.0.versions[0]) }
    return nil
  }

  /// A DOI's paper: the entry the vault has for it (its newest PDF opened, when it has one), else a new one without a
  /// version; the list of the resource it is in opened
  private func addDOI(_ doi: String, to resource: VaultResource) async -> String? {
    if let found = reading.entries.doi(doi) {
      let pdf = found.entry.versions.last { v in if case .pdf = v.content { v.of == nil } else { false } }
      if let pdf {
        openPDF(.entry(found.entry.id, version: pdf.id))
      } else if let r = tree?.allFolders.flatMap(\.resources).first(where: { found.path.hasPrefix($0.path + "/") }) {
        openResource(r)
      }
      return nil
    }
    do {
      let paper = try await reading.doi.paper(doi)
      guard files({ v in _ = try v.newEntry(paper, in: resource.path) }) else {
        return fileError ?? "The paper could not be added."
      }
    } catch {
      return error.description
    }
    openResource(resource)
    return nil
  }

  private func queueTranslation(_ e: Entry, _ v: Version) {
    guard let vault, let job = TranslationJob(vault: vault, entry: e, version: v) else { return }
    reading.translations?.add(job)
  }

  /// Rename Board… (the toolbar's ⋯): the open board's row shown in the sidebar, its name written in place there; a
  /// folder's own board is its folder's row
  public func renameOpenBoard() {
    guard let (b, folder) = revealOpenBoard() else { return }
    renaming = b.isFolderBoard ? .folder(folder) : .board(b.id)
  }

  /// Edit Mark… (the toolbar's ⋯): the open board's seal edited beside its row in the sidebar
  public func editOpenBoardMark() {
    guard let (b, _) = revealOpenBoard(), !b.isFolderBoard else { return }
    sealEditing = b.id
  }

  /// The open board and its folder, its row shown: the sidebar shown, every folder it is in open
  private func revealOpenBoard() -> (VaultBoard, String)? {
    guard let id = current?.board, let b = tree?.allBoards.first(where: { $0.id == id }) else { return nil }
    let folders = b.path.split(separator: "/").dropLast()
    for i in folders.indices { expanded.insert(folders[...i].joined(separator: "/")) }
    sidebarShown = true
    return (b, folders.joined(separator: "/"))
  }

  /// A new folder in `folder`, its name written in place
  public func newFolder(in folder: String) {
    var path: String?
    files { v in path = try v.newFolder(in: folder, name: v.freeName(in: folder, "New Folder", package: false)) }
    guard let path else { return }
    if !folder.isEmpty { expanded.insert(folder) }
    renaming = .folder(path)
  }

  /// The folder's own board, made and shown
  public func newFolderBoard(in folder: String) {
    var made: VaultBoard?
    files { v in made = try v.newFolderBoard(in: folder) }
    if let made { show(made.id) }
  }

  public func rename(board: VaultBoard, to title: String) {
    let t = title.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !t.isEmpty, t != board.title else { return }
    files { v in try v.rename(board: board, to: t) }
  }

  public func rename(resource: VaultResource, to title: String) {
    let t = title.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !t.isEmpty, t != resource.title else { return }
    files { v in try v.rename(resource: resource, to: t) }
  }

  public func rename(folder path: String, to name: String) {
    let n = name.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !n.isEmpty, n != path.split(separator: "/").last.map(String.init) else { return }
    var to: String?
    files { v in
      to = try v.rename(folder: path, to: n)
      let parts = path.split(separator: "/").map(String.init)
      folderRenamed?(parts.dropLast().joined(separator: "/"), parts.last ?? "", n)
    }
    if let to { follow(path, to) }
  }

  /// A board or resource package or a folder moved into `folder` (the vault itself: ""); its new path
  @discardableResult
  public func move(_ path: String, into folder: String) -> String? {
    var to: String?
    let left = leaving(path)
    files { v in
      to = try v.move(path, into: folder)
      if to != path, let left { entryLeft?(left.folder, left.entry) }
    }
    if let to {
      follow(path, to)
      if !folder.isEmpty { expanded.insert(folder) }
    }
    return to
  }

  /// To the trash (`trasher`: the system Trash in the app); nothing changes when it cannot go there (a beep)
  @discardableResult
  public func trash(_ path: String) -> Bool {
    let left = leaving(path)
    let ok = files { v in
      try v.trash(path, with: trasher)
      if let left { entryLeft?(left.folder, left.entry) }
    }
    guard ok else { return false }
    expanded = expanded.filter { $0 != path && !$0.hasPrefix(path + "/") }
    return true
  }

  /// What a folder's folder board has a card for that goes with a board or subfolder at `path` (none for a folder
  /// board: its folder stays)
  private func leaving(_ path: String) -> (folder: String, entry: FolderEntry)? {
    if let b = tree?.allBoards.first(where: { $0.path == path }) {
      return b.isFolderBoard ? nil : (b.folder, .board(b.id))
    }
    guard tree?.folder(at: path) != nil, let name = path.split(separator: "/").last else { return nil }
    return (path.split(separator: "/").dropLast().joined(separator: "/"), .folder(String(name)))
  }

  /// Expanded folders at or under a folder that moved keep their state at their new paths
  private func follow(_ from: String, _ to: String) {
    expanded = Set(
      expanded.map { p in
        p == from ? to : p.hasPrefix(from + "/") ? to + p.dropFirst(from.count) : p
      })
  }
}
