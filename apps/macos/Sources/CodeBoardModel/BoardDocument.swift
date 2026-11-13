import Foundation

/// One open board: the board as edited, its undo history and selection, saving by itself and taking in what another
/// writer changed. One per board while the app runs (every tab on the board shares it, and its history outlives tab
/// switches); nothing of it is kept across launches.
///
/// Saving: `saveDelay` after the last change, the board's file is written whole and atomically with the deterministic
/// writer; `flush()` writes at once (quitting, closing a tab). There is no save command.
///
/// Another writer: `diskChanged()` reads the file; when it is not what this document last read or wrote, it is merged in
/// (`Board.merge` against that version), without asking. The merge is no undo step, and the steps it broke are dropped.
/// A file it cannot read (a newer format, broken JSON) stops saving until it can be read again, so it is never written
/// over.
@MainActor public final class BoardDocument {
  public enum Change: Sendable {
    /// A command or gesture of this app, or its undo or redo
    case edit
    /// What another writer changed, merged in
    case merge
  }

  public let id: BoardID
  public private(set) var board: Board
  /// The selection on the canvas, kept with the board so undo restores it
  public var selection: Set<Item> = []
  public private(set) var history = History()
  /// Why the file on disk cannot be read now; saving waits while it is set
  public private(set) var problem: String?

  /// How long after the last change it is written
  public static let saveDelay = Duration.milliseconds(300)

  /// The version last read from or written to disk, which a merge compares against, and its bytes
  private var base: Board
  private var baseData: Data
  /// Where the file is now: asked at every read and write, as the package may have been renamed or moved meanwhile
  private let file: () -> URL?
  private var saving: Task<Void, Never>?
  private var observers: [UUID: (Change) -> Void] = [:]

  /// The document of the board in `file`, as read now
  public init(file: @escaping () -> URL?) throws {
    guard let url = file() else { throw CocoaError(.fileNoSuchFile) }
    let data: Data
    do {
      data = try Data(contentsOf: url)
    } catch {
      throw VaultError.unreadable(url, error.localizedDescription)
    }
    let b = try Board(decoding: data, file: url)
    id = b.id
    board = b
    base = b
    baseData = data
    self.file = file
  }

  /// Called after every change of the board or the selection; returns what stops it
  public func observe(_ f: @escaping (Change) -> Void) -> () -> Void {
    let key = UUID()
    observers[key] = f
    return { [weak self] in self?.observers[key] = nil }
  }

  /// Not saved yet
  public var isDirty: Bool { board != base }

  // MARK: Editing

  /// One undo step: `change` applied to the board, the selection after it `selection` (nil: as it is). Nothing happens
  /// when it changes nothing
  public func edit(_ name: String, selection after: Set<Item>? = nil, _ change: (inout Board) -> Void) {
    var b = board
    change(&b)
    let before = selection
    let now = (after ?? selection).filter { b.has($0) }
    guard b != board else {
      if now != selection { select(now) }
      return
    }
    history.record(name, from: board, to: b, selection: (before, now))
    board = b
    selection = now
    changed(.edit)
  }

  public func select(_ items: Set<Item>) {
    selection = items.filter { board.has($0) }
    for o in observers.values { o(.edit) }
  }

  /// The names of the steps undo and redo would take
  public var undoName: String? { history.undoSteps.last?.name }
  public var redoName: String? { history.redoSteps.last?.name }

  public func undo() {
    var b = board
    guard let sel = history.undo(&b) else { return }
    board = b
    selection = sel.filter { b.has($0) }
    changed(.edit)
  }

  public func redo() {
    var b = board
    guard let sel = history.redo(&b) else { return }
    board = b
    selection = sel.filter { b.has($0) }
    changed(.edit)
  }

  private func changed(_ c: Change) {
    for o in observers.values { o(c) }
    scheduleSave()
  }

  // MARK: Saving

  private func scheduleSave() {
    saving?.cancel()
    guard isDirty else { return }
    saving = Task { [weak self] in
      try? await Task.sleep(for: BoardDocument.saveDelay)
      guard !Task.isCancelled else { return }
      self?.flush()
    }
  }

  /// Writes the board now when it changed since it was last read or written. What another writer put there meanwhile
  /// is merged in first, so it is never written over
  public func flush() {
    saving?.cancel()
    saving = nil
    guard let url = file() else { return }
    if let disk = try? Data(contentsOf: url), disk != baseData || problem != nil { take(disk, from: url) }
    guard problem == nil, isDirty else { return }
    // never a file that cannot be read back: it stays unsaved, and says why
    if let p = board.problem() {
      problem = "\(url.path): not saved, as it would not read back: \(p)"
      return
    }
    do {
      let data = try board.encoded()
      try data.write(to: url, options: .atomic)
      base = board
      baseData = data
    } catch {
      problem = "\(url.path): cannot be written: \(error.localizedDescription)"
    }
  }

  // MARK: Another writer

  /// The vault changed on disk: when this board's file is not what was last read or written, it is merged in
  public func diskChanged() {
    guard let url = file(), let disk = try? Data(contentsOf: url), disk != baseData || problem != nil else { return }
    take(disk, from: url)
    scheduleSave()
  }

  private func take(_ data: Data, from url: URL) {
    let theirs: Board
    do {
      theirs = try Board(decoding: data, file: url)
    } catch {
      // never written over: it stays as the other writer left it until it can be read
      problem = String(describing: error)
      return
    }
    problem = nil
    let merged = Board.merge(base: base, mine: board, disk: theirs)
    base = theirs
    baseData = data
    guard merged != board else { return }
    board = merged
    history.keep(holdingOn: merged)
    selection = selection.filter { merged.has($0) }
    for o in observers.values { o(.merge) }
  }
}

extension Board {
  /// Whether the card or Section is on the canvas
  public func has(_ item: Item) -> Bool {
    switch item {
    case .card(let id): card(id) != nil
    case .section(let id): section(id) != nil
    }
  }
}
