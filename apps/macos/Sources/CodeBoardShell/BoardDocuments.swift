import CodeBoardModel
import Foundation

/// The open boards of the app, one document per board whichever window and tab shows it, and what is done to them
/// that is not about one window: opening one, keeping folder boards up, shared cards, seals, writing them all
@MainActor final class BoardDocuments {
  let session: VaultSession

  init(session: VaultSession) {
    self.session = session
  }

  /// One document per board while the app runs, whichever tabs show it, so its undo history outlives tab switches
  private(set) var open: [BoardID: BoardDocument] = [:]

  func document(_ id: BoardID) throws -> BoardDocument {
    if let doc = open[id] { return doc }
    // ponytail: reads board.json on the main thread when a board is first opened; move off it if large boards stall
    // its shared cards are read in from the vault open now (documents go when it changes: closeAll())
    let doc = try BoardDocument(
      file: { [weak session] in
        guard let session, let vault = session.vault, let at = session.board(id) else { return nil }
        return vault.url(of: at.path).appending(path: Vault.boardFileName)
      }, vault: session.vault)
    open[id] = doc
    return doc
  }

  /// The title each board seen while the app runs last had: a missing automatic card finds its board again by it
  private var known: [BoardID: String] = [:]

  /// Each open folder board keeps one automatic card for each board and subfolder in its folder (no undo step)
  func keepFolderBoardsUp() {
    guard let tree = session.tree else { return }
    let titles = Dictionary(tree.allBoards.map { ($0.id, $0.title) }, uniquingKeysWith: { a, _ in a })
    defer { known.merge(titles) { _, new in new } }
    for (id, doc) in open {
      guard let at = session.board(id), at.isFolderBoard, let folder = tree.folder(at: at.folder) else { continue }
      doc.sync { $0.keepUp(with: folder.entries, titles: titles, known: known) }
    }
  }

  /// The boards showing shared card `id` now: an open one as it is edited, the others as their files hold them
  // ponytail: reads every board not open on each ask (its menu, ⌘⌫); keep an index with the vault watcher if vaults grow
  func boardsShowing(_ id: CardID) -> [VaultBoard] {
    guard let vault = session.vault else { return [] }
    return (session.tree?.allBoards ?? []).filter { b in
      let board = open[b.id]?.board ?? (try? vault.board(at: b.path))
      return board?.cards.contains { $0.id == id && $0.isShared } == true
    }
  }

  /// A shared card deleted everywhere from another board goes from this one as the host takes it (storage deleteEverywhere,
  /// core cards.ts dropGone): no undo step here; a board not open is read, changed and written
  func remove(_ id: CardID, from b: VaultBoard) {
    let doc =
      open[b.id]
      ?? (try? BoardDocument(
        file: { [weak session] in
          guard let session, let vault = session.vault, let at = session.board(b.id) else { return nil }
          return vault.url(of: at.path).appending(path: Vault.boardFileName)
        }, vault: session.vault))
    doc?.sync { $0.delete([.card(id)], ignoringLock: true) }
    doc?.flush()
  }

  /// Cards copied on board `id` and pasted on another become shared cards there first (host storage/boards.ts share),
  /// written at once so the other board finds their files; returns their ids there now (old → new) and its title. No
  /// cards: only the title
  func share(_ id: BoardID, _ cards: Set<CardID>) -> (ids: [CardID: CardID], title: String)? {
    guard let vault = session.vault, let at = session.board(id), let doc = try? document(id) else { return nil }
    var ids: [CardID: CardID] = [:]
    if !cards.isEmpty {
      doc.sync { ids = $0.share(cards, taken: vault.sharedCardExists) }
      doc.flush()
    }
    return (ids, at.title)
  }

  /// Where each board whose seal is being edited began
  private var sealBefore: [BoardID: Seal?] = [:]

  /// A board's seal set at once and written; once done, all that changed while editing is one undo step on that board,
  /// none when it ends where it began. False when there is no vault or the board cannot be opened: nothing was set
  func setSeal(_ id: BoardID, _ seal: Seal?, done: Bool) -> Bool {
    guard session.vault != nil, let doc = try? document(id) else { return false }
    let from = sealBefore[id] ?? doc.board.seal
    if done {
      sealBefore[id] = nil
      doc.preview { $0.seal = from }
      if seal != from { doc.edit("Edit Mark") { $0.seal = seal } }
    } else {
      sealBefore[id] = from
      doc.preview { $0.seal = seal }
    }
    doc.flush()
    return true
  }

  /// A board or subfolder deleted or moved away from the sidebar, before the tree is read again: its folder's folder
  /// board lets its card go
  func entryLeft(_ parent: String, _ entry: FolderEntry) {
    guard let fb = session.tree?.folder(at: parent)?.folderBoard, let doc = try? document(fb.id) else { return }
    doc.sync { $0.dropAutoCard(for: entry.target) }
    doc.flush()
  }

  /// A subfolder renamed in the sidebar, before the tree is read again: its parent's folder board keeps its card where
  /// it was
  func folderRenamed(_ parent: String, _ old: String, _ new: String) {
    guard let fb = session.tree?.folder(at: parent)?.folderBoard, let doc = try? document(fb.id) else { return }
    doc.sync { $0.renameFolderCard(old, to: new) }
    doc.flush()
  }

  /// The vault changed on disk: every open board takes in what changed there
  func diskChanged() {
    for doc in open.values { doc.diskChanged() }
  }

  /// Writes every board with changes not yet saved (quitting, another vault); returns the boards whose changes could
  /// not be written, by title, with why
  func flush() -> [(title: String, why: String)] {
    var unsaved: [(title: String, why: String)] = []
    for (id, doc) in open {
      doc.flush()
      if doc.isDirty, let why = doc.problem { unsaved.append((session.board(id)?.title ?? id.rawValue, why)) }
    }
    return unsaved.sorted { $0.title < $1.title }
  }

  /// Lets go of every document (another vault)
  func closeAll() {
    open = [:]
  }
}
