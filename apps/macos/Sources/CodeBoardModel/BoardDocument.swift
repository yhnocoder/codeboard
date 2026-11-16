import Foundation

/// One open board: the board as edited, its undo history, saving by itself and taking in what another writer changed.
/// One per board while the app runs (every tab on the board shares it, and its history outlives tab switches); nothing
/// of it is kept across launches.
///
/// Selection: each view on the board (a canvas) sits at a seat of its own (`Seat`, `seat(for:)`), with its own
/// selection, so that two windows on one board select apart. The first to sit has the document's own seat, which
/// `selection`, `select`, `edit`, `undo` and the rest here act for: with one canvas on the board, its selection is the
/// document's.
///
/// Saving: `saveDelay` after the last change, the board's file is written whole and atomically with the deterministic
/// writer; `flush()` writes at once (quitting, closing a tab). There is no save command.
///
/// Another writer: `diskChanged()` reads the file; when it is not what this document last read or wrote, it is merged in
/// (`Board.merge` against that version), without asking. The merge is no undo step, and the steps it broke are dropped.
/// A file it cannot read (a newer format, broken JSON) stops saving until it can be read again, so it is never written
/// over.
///
/// Shared cards (given the vault): their content and travelling sidenotes are read in from their own files, so editing
/// one on this board edits the shared card; saving writes each one that changed back to its file (with the images it
/// shows, copied into the shared images folder where that has none of the name), and another writer's change of one is
/// merged in as a change of the board file is. 同一块白板的共享卡 are kept the same after every change.
@MainActor public final class BoardDocument {
  public enum Change: Sendable {
    /// A command or gesture of this app, or its undo or redo
    case edit
    /// What another writer changed, merged in
    case merge
    /// What is typed in a card being written in, so far: on the board and saved, no undo step (the writing becomes one
    /// when it ends)
    case draft
  }

  public let id: BoardID
  public private(set) var board: Board
  /// The selection of the document's own seat, kept with the board so undo restores it
  public var selection: Set<Item> {
    get { mainPlace.selection }
    set { mainPlace.selection = newValue }
  }
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
  /// Where shared cards are read from and written to; nil: they stay unread (`.shared`)
  private let vault: Vault?
  /// Each shared card file read or written, as its bytes were then (nil: it was not there)
  private var sharedData: [CardID: Data?] = [:]
  private var saving: Task<Void, Never>?
  /// The document's own seat's selection and observers, kept while the document is open, whoever sits there
  private let mainPlace = Place()
  /// Who sits at the document's own seat now; none (or its holder gone): it is free
  private weak var mainSeat: Seat?
  /// The other seats taken, as long as they are held
  private var others: [Held] = []

  /// The document of the board in `file`, as read now, its shared cards read in from `vault`
  public init(file: @escaping () -> URL?, vault: Vault? = nil) throws {
    guard let url = file() else { throw CocoaError(.fileNoSuchFile) }
    let data: Data
    do {
      data = try Data(contentsOf: url)
    } catch {
      throw VaultError.unreadable(url, error.localizedDescription)
    }
    self.vault = vault
    self.file = file
    var shared: [CardID: Data?] = [:]
    let b = Self.inflate(try Board(decoding: data, file: url), vault, &shared)
    sharedData = shared
    id = b.id
    board = b
    base = b
    baseData = data
  }

  /// `b` with its shared cards read in from the vault, noting each file's bytes in `read`
  private static func inflate(_ b: Board, _ vault: Vault?, _ read: inout [CardID: Data?]) -> Board {
    guard let vault else { return b }
    var seen: [CardID: Data?] = [:]
    let out = b.inflated { id in
      guard Vault.isSafeID(id.rawValue) else { return nil }
      let url = vault.sharedFolderURL.appending(path: "\(id.rawValue).json")
      let data = try? Data(contentsOf: url)
      seen[id] = data
      return data.flatMap { try? SharedCard(decoding: $0, file: url) }.flatMap { $0.id == id ? $0 : nil }
    }
    read.merge(seen) { $1 }
    return out
  }

  private func sharedFile(_ id: CardID) -> URL? {
    guard let vault, Vault.isSafeID(id.rawValue) else { return nil }
    return vault.sharedFolderURL.appending(path: "\(id.rawValue).json")
  }

  /// Each shared card on the board whose file is not what was last read or written there (or was never read here: one
  /// just pasted) takes what the file has now, on the board and in what undo and the writing go back to. The file wins
  /// over a change here not written yet. Whether anything changed
  private func refreshShared() -> Bool {
    var changed = false
    let ids = Set((board.cards + board.shelf.flatMap(\.cards)).filter(\.isShared).map(\.id))
    for id in ids.sorted(by: { $0.rawValue < $1.rawValue }) {
      guard let url = sharedFile(id) else { continue }
      let now = try? Data(contentsOf: url)
      if let was = sharedData[id], was == now { continue }
      sharedData[id] = now
      guard let now, let card = try? SharedCard(decoding: now, file: url), card.id == id else { continue }
      let before = board
      board.putShared(card)
      base.putShared(card)
      writing?.before.putShared(card)
      history.keep(holdingOn: board)
      changed = changed || board != before
    }
    return changed
  }

  /// The change, and 同一块白板的共享卡 kept the same after it
  private func apply(_ change: (inout Board) -> Void, to b: inout Board) {
    let before = b
    change(&b)
    b.syncTwins(since: before)
  }

  /// Called after every change of the board or of the document's own seat's selection; returns what stops it
  public func observe(_ f: @escaping (Change) -> Void) -> () -> Void { observe(f, at: mainPlace) }

  fileprivate func observe(_ f: @escaping (Change) -> Void, at place: Place) -> () -> Void {
    let key = UUID()
    place.observers[key] = f
    return { [weak place] in place?.observers[key] = nil }
  }

  // MARK: Seats

  /// The seat `holder` (a canvas) has at this board: the one it was given, while it holds it; else the document's own
  /// when no living holder has that; else a new one
  public func seat(for holder: AnyObject) -> Seat {
    others.removeAll { $0.seat == nil }
    if let s = mainSeat, s.holder === holder { return s }
    if let s = others.first(where: { $0.seat?.holder === holder })?.seat { return s }
    guard mainSeat?.holder != nil else {
      let s = Seat(self, mainPlace, holder: holder)
      mainSeat = s
      return s
    }
    let s = Seat(self, Place(), holder: holder)
    others.append(Held(seat: s))
    return s
  }

  /// Gives a seat back: the document's own is free for the next holder, keeping its selection; another is forgotten
  fileprivate func leave(_ s: Seat) {
    s.holder = nil
    if mainSeat === s { mainSeat = nil }
    others.removeAll { $0.seat == nil || $0.seat === s }
  }

  /// The document's own seat's place and every other seat's still held
  private var places: [Place] { [mainPlace] + others.compactMap { $0.seat?.place } }

  /// Every seat's selection but `acting`'s loses what is not on `b`
  private func keepSelections(on b: Board, but acting: Place? = nil) {
    for p in places where p !== acting { p.selection = p.selection.filter { b.has($0) } }
  }

  /// Every seat's observers
  private func notify(_ c: Change) {
    for p in places { for o in p.observers.values { o(c) } }
  }

  /// Not saved yet
  public var isDirty: Bool { board != base }

  // MARK: Editing

  /// One undo step: `change` applied to the board, the selection after it `selection` (nil: as it is). Nothing happens
  /// when it changes nothing
  public func edit(_ name: String, selection after: Set<Item>? = nil, _ change: (inout Board) -> Void) {
    edit(name, selection: after, change, by: mainPlace)
  }

  /// An edit by the seat at `place`: its selection is the step's, every other seat's only loses what left the board
  fileprivate func edit(_ name: String, selection after: Set<Item>?, _ change: (inout Board) -> Void, by place: Place) {
    var b = board
    apply(change, to: &b)
    let before = place.selection
    let now = (after ?? place.selection).filter { b.has($0) }
    guard b != board else {
      if now != place.selection { select(now, by: place) }
      return
    }
    if var w = writing {
      // a card is being written in: the step is taken on the board without what is typed so far (its drafts), so that
      // undoing it never brings a draft back; the writing's own step starts from after it
      var nb = w.before
      apply(change, to: &nb)
      history.record(name, from: w.before, to: nb, selection: (before, now), epoch: derived)
      w.before = nb
      writing = w
    } else {
      history.record(name, from: board, to: b, selection: (before, now), epoch: derived)
    }
    board = b
    place.selection = now
    keepSelections(on: b, but: place)
    changed(.edit)
  }

  /// A change the app makes by itself (a folder board's automatic cards kept in step with its folder): on the board and
  /// saved, no undo step, as another writer's change is; the steps it breaks are dropped
  public func sync(_ change: (inout Board) -> Void) {
    var b = board
    apply(change, to: &b)
    guard b != board else { return }
    if var w = writing {
      apply(change, to: &w.before)
      writing = w
    }
    board = b
    history.keep(holdingOn: b)
    keepSelections(on: b)
    notify(.merge)
    scheduleSave()
  }

  /// A change shown and saved while it is being made (a seal typed in its popover): no undo step, and none dropped,
  /// since it is put back before the one step it ends in
  public func preview(_ change: (inout Board) -> Void) {
    var b = board
    apply(change, to: &b)
    guard b != board else { return }
    board = b
    notify(.merge)
    scheduleSave()
  }

  /// What the app learned by itself about the board (a page's details read once): on the board and saved, no undo step
  /// and none dropped; run again after an undo or redo that puts back what it was learned on (core history: syncs
  /// replayed after undo), so a paste redone gets its page back without reading it again. `change` must work on an
  /// older board: find by id, skip what is gone. Kept while a step older than it is on a stack, at most 2000.
  /// Only fields the user never changes through an undo step may be written here (a page's details, never a title or a
  /// style the user can set): the replay after an undo or redo would write over the user's change
  public func derive(_ change: @escaping (inout Board) -> Void) {
    derived += 1
    derivedLog.append((derived, change))
    trimDerived()
    if var w = writing {
      apply(change, to: &w.before)
      writing = w
    }
    var b = board
    apply(change, to: &b)
    guard b != board else { return }
    board = b
    notify(.merge)
    scheduleSave()
  }

  private var derived = 0
  private var derivedLog: [(n: Int, change: (inout Board) -> Void)] = []

  private func trimDerived() {
    let min = history.oldestEpoch ?? derived
    derivedLog.removeAll { $0.n <= min }
    if derivedLog.count > 2000 { derivedLog.removeFirst(derivedLog.count - 2000) }
  }

  /// The derived changes made since a step was recorded, run again on the board it put back
  private func replayDerived(after epoch: Int, on b: inout Board) {
    for d in derivedLog where d.n > epoch { apply(d.change, to: &b) }
  }

  // MARK: Writing in a card

  /// A card being written in: the board as it was when the writing began, which the one undo step the writing becomes
  /// starts from. What is typed meanwhile reaches the board (and the disk) as drafts with no step. `isNew`: a card just
  /// made and not written yet (core CommandEnv.fresh), which goes and leaves no step when it is left empty. `place`:
  /// the seat writing, whose selection the writing gives back or sets when it ends. One writing a document: what a
  /// seat starting to write while another seat writes does is for a later change
  private var writing: (id: CardID, before: Board, selection: Set<Item>, isNew: Bool, place: Place)?

  public var freshCard: CardID? { writing?.isNew == true ? writing?.id : nil }

  /// Puts a new card on the board, selected, with no undo step yet: it is being written in
  public func addFresh(_ card: Card) { addFresh(card, by: mainPlace) }

  fileprivate func addFresh(_ card: Card, by place: Place) {
    if let w = writing { settleWriting(keep: !w.isNew, "") { _ in } }
    writing = (card.id, board, place.selection, true, place)
    board.cards.append(card)
    place.selection = [.card(card.id)]
    changed(.edit)
  }

  /// A card on the board starts being written in
  public func beginWriting(_ id: CardID) { beginWriting(id, by: mainPlace) }

  fileprivate func beginWriting(_ id: CardID, by place: Place) {
    guard writing == nil else { return }
    writing = (id, board, place.selection, false, place)
  }

  /// What is typed so far, onto the board with no undo step; saved as any change is. A draft never takes the card
  /// being written in off the board (with what points at it): only the end of the writing may
  public func draft(_ change: (inout Board) -> Void) {
    guard let w = writing else { return }
    var b = board
    apply(change, to: &b)
    guard b != board, board.card(w.id) == nil || b.card(w.id) != nil else { return }
    board = b
    changed(.draft)
  }

  /// The writing ends with `change`: from where it began to now is one undo step named `name` (none when that changed
  /// nothing). A new card not kept (`keep` false) goes as if it had never been, and the selection it took is given back
  /// to the seat that was writing, whichever seat ends it
  public func settleWriting(keep: Bool, _ name: String, _ change: (inout Board) -> Void) {
    guard let w = writing else { return }
    writing = nil
    var b = board
    apply(change, to: &b)
    let dropped = w.isNew && !keep
    if dropped { b.delete([.card(w.id)]) }
    let now = (dropped ? w.selection : w.place.selection).filter { b.has($0) }
    if !dropped && b != w.before { history.record(name, from: w.before, to: b, selection: (w.selection, now)) }
    guard b != board || now != w.place.selection else { return }
    board = b
    w.place.selection = now
    keepSelections(on: b, but: w.place)
    changed(.edit)
  }

  public func select(_ items: Set<Item>) { select(items, by: mainPlace) }

  /// Only the seat's own observers hear of it: no other seat's selection changed
  fileprivate func select(_ items: Set<Item>, by place: Place) {
    place.selection = items.filter { board.has($0) }
    for o in place.observers.values { o(.edit) }
  }

  /// The names of the steps undo and redo would take
  public var undoName: String? { history.undoSteps.last?.name }
  public var redoName: String? { history.redoSteps.last?.name }

  public func undo() { undo(by: mainPlace) }

  public func redo() { redo(by: mainPlace) }

  /// The seat at `place` gets the step's selection back; every other seat's only loses what left the board
  fileprivate func undo(by place: Place) {
    var b = board
    let epoch = history.undoSteps.last?.epoch ?? derived
    guard let sel = history.undo(&b) else { return }
    replayDerived(after: epoch, on: &b)
    board = b
    place.selection = sel.filter { b.has($0) }
    keepSelections(on: b, but: place)
    changed(.edit)
  }

  fileprivate func redo(by place: Place) {
    var b = board
    let epoch = history.redoSteps.last?.epoch ?? derived
    guard let sel = history.redo(&b) else { return }
    replayDerived(after: epoch, on: &b)
    board = b
    place.selection = sel.filter { b.has($0) }
    keepSelections(on: b, but: place)
    changed(.edit)
  }

  private func changed(_ c: Change) {
    notify(c)
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
    if refreshShared() { notify(.merge) }
    guard problem == nil, isDirty else { return }
    // never a file that cannot be read back: it stays unsaved, and says why
    if let p = board.problem() ?? board.twinProblem() {
      problem = "\(url.path): not saved, as it would not read back: \(p)"
      return
    }
    do {
      let (flat, shared) = board.deflated()
      for card in shared { try writeShared(card, package: url.deletingLastPathComponent()) }
      let data = try canonicalJSON(flat)
      if data != baseData { try data.write(to: url, options: .atomic) }
      base = board
      baseData = data
    } catch {
      problem = "\(url.path): cannot be written: \(error.localizedDescription)"
    }
  }

  /// A shared card's file written when it changed, never over a file that is not what was last read there; the images
  /// it shows are copied from the board's images folder into the shared one where that has none of the name
  private func writeShared(_ card: SharedCard, package: URL) throws {
    guard let file = sharedFile(card.id), let vault else { return }
    let data = try card.encoded()
    let was = sharedData[card.id] ?? nil
    guard data != was else { return }
    let there = try? Data(contentsOf: file)
    if there == data {
      sharedData[card.id] = data
      return
    }
    // another writer's, not taken in yet (refreshShared): never written over
    guard there == was else { return }
    let from = package.appending(path: Vault.imagesFolder)
    let to = vault.sharedFolderURL.appending(path: Vault.imagesFolder)
    for name in card.imageFiles.sorted() where Vault.isFileName(name) {
      let src = from.appending(path: name)
      let dst = to.appending(path: name)
      guard FileManager.default.fileExists(atPath: src.path), !FileManager.default.fileExists(atPath: dst.path)
      else { continue }
      try FileManager.default.createDirectory(at: to, withIntermediateDirectories: true)
      try? FileManager.default.copyItem(at: src, to: dst)
    }
    try FileManager.default.createDirectory(at: file.deletingLastPathComponent(), withIntermediateDirectories: true)
    try data.write(to: file, options: was == nil ? .withoutOverwriting : .atomic)
    sharedData[card.id] = data
  }

  // MARK: Another writer

  /// The vault changed on disk: when this board's file is not what was last read or written, it is merged in
  public func diskChanged() {
    guard let url = file(), let disk = try? Data(contentsOf: url) else { return }
    let boardChanged = disk != baseData || problem != nil
    if boardChanged { take(disk, from: url) }
    let sharedChanged = refreshShared()
    if sharedChanged { notify(.merge) }
    if boardChanged || sharedChanged { scheduleSave() }
  }

  private func take(_ data: Data, from url: URL) {
    let theirs: Board
    do {
      var read: [CardID: Data?] = [:]
      theirs = Self.inflate(try Board(decoding: data, file: url), vault, &read)
      sharedData.merge(read) { $1 }
    } catch {
      // never written over: it stays as the other writer left it until it can be read
      problem = String(describing: error)
      return
    }
    problem = nil
    var merged = Board.merge(base: base, mine: board, disk: theirs)
    merged.syncTwins(since: board)
    // what the writing's step will start from takes in the other writer's changes too, so undoing it leaves them
    if let w = writing { writing?.before = Board.merge(base: base, mine: w.before, disk: theirs) }
    base = theirs
    baseData = data
    guard merged != board else { return }
    board = merged
    history.keep(holdingOn: merged)
    keepSelections(on: merged)
    notify(.merge)
  }
}

extension BoardDocument {
  /// What one seat has of its own: its selection and who watches it
  fileprivate final class Place {
    var selection: Set<Item> = []
    var observers: [UUID: (Change) -> Void] = [:]
  }

  /// A seat no longer held is not kept for it
  fileprivate struct Held {
    weak var seat: Seat?
  }

  /// One view's place at an open board: each canvas showing the board has one (`seat(for:)`), with its own selection,
  /// which its edits, undo and redo record and get back; what it does to the board is the document's, and every seat
  /// sees it. Same names as on the document, so a canvas edits through its seat as through the document
  @MainActor public final class Seat {
    /// The open board it sits at, kept open while the seat is held
    public let document: BoardDocument
    fileprivate let place: Place
    /// Who was given it; gone, the document's own seat is free for another holder
    fileprivate weak var holder: AnyObject?

    fileprivate init(_ document: BoardDocument, _ place: Place, holder: AnyObject) {
      self.document = document
      self.place = place
      self.holder = holder
    }

    /// Gives it back to the document (the canvas shows another board, or none)
    public func leave() { document.leave(self) }

    public var selection: Set<Item> { place.selection }
    public func select(_ items: Set<Item>) { document.select(items, by: place) }
    public func edit(_ name: String, selection after: Set<Item>? = nil, _ change: (inout Board) -> Void) {
      document.edit(name, selection: after, change, by: place)
    }
    public func undo() { document.undo(by: place) }
    public func redo() { document.redo(by: place) }
    public func addFresh(_ card: Card) { document.addFresh(card, by: place) }
    public func beginWriting(_ id: CardID) { document.beginWriting(id, by: place) }
    public func settleWriting(keep: Bool, _ name: String, _ change: (inout Board) -> Void) {
      document.settleWriting(keep: keep, name, change)
    }
    /// Called after every change of the board or of this seat's selection; returns what stops it
    public func observe(_ f: @escaping (Change) -> Void) -> () -> Void { document.observe(f, at: place) }

    public var id: BoardID { document.id }
    public var board: Board { document.board }
    public var history: History { document.history }
    public var problem: String? { document.problem }
    public var isDirty: Bool { document.isDirty }
    public var undoName: String? { document.undoName }
    public var redoName: String? { document.redoName }
    public var freshCard: CardID? { document.freshCard }
    public func sync(_ change: (inout Board) -> Void) { document.sync(change) }
    public func preview(_ change: (inout Board) -> Void) { document.preview(change) }
    public func derive(_ change: @escaping (inout Board) -> Void) { document.derive(change) }
    public func draft(_ change: (inout Board) -> Void) { document.draft(change) }
    public func flush() { document.flush() }
    public func diskChanged() { document.diskChanged() }
  }
}

extension Board {
  /// Whether the card or Section is on the canvas
  public func has(_ item: Item) -> Bool {
    switch item {
    case .card(let id): card(id) != nil
    case .section(let id): section(id) != nil
    case .arrow(let id): arrows.contains { $0.id == id }
    case .sticker(let id): stickers.contains { $0.id == id }
    }
  }
}
