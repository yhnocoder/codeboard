import AppKit
import CodeBoardCanvas
import CodeBoardModel
import CodeBoardNotes
import CodeBoardReading
import CodeBoardWorkspace
import SwiftUI
import os

// Where a code tab's lines are on the vault's boards (CodeHost.onBoards), going to such a card, and a code card's file
// opened from its header. Every board is read as ⌘K reads them, without opening it in a canvas: an open board as its
// document has it now (its changes heard through the document), the others from their files, read again when a file
// or the shared cards' folder changed. A card from another commit than the file is shown at has its lines followed
// through the line diff between that commit's text and the file; when that commit is not on this Mac, by their text.

extension ShellCode {
  /// The vault's boards as they are now: the vault, its boards in the tree's order, the open ones' documents
  struct Boards {
    var vault: Vault
    var all: [VaultBoard]
    var open: [BoardID: BoardDocument]
  }

  /// A code card with a source, on a board
  struct Placed: Equatable, Sendable {
    var card: CardID
    var title: String
    var segment: Segment
  }

  /// A board's code cards read from its files, with when the board's file and the shared cards' folder were written
  struct Read: Sendable {
    var stamp: [Date?]
    var cards: [Placed]
  }

  struct Watched {
    var doc: ObjectIdentifier
    var stop: () -> Void
    var cards: [Placed]
  }

  struct LinesKey: Hashable {
    var text: Int
    var source: String
    var first: Int
    var lines: [String]
  }

  /// The code cards with a source on a board (not on its Shelf), each segment of them
  nonisolated static func placed(_ b: Board) -> [Placed] {
    b.cards.flatMap { c -> [Placed] in
      guard case .own(let content) = c.content, case .code(let code) = content.body else { return [] }
      return code.segments.filter { $0.source != nil }.map {
        Placed(card: c.id, title: cardTitle(content), segment: $0)
      }
    }
  }

  /// Every board's code cards, in the tree's order: the open ones as they are now, the others as their files are
  func cards() async -> [(board: VaultBoard, cards: [Placed])] {
    guard let b = boards() else { return [] }
    watch(b.open)
    let unread = b.all.filter { b.open[$0.id] == nil }
    let have = read
    let vault = b.vault
    let fresh = await Task.detached(priority: .utility) { () -> [BoardID: Read] in
      let shared = Self.stamp(vault.sharedFolderURL)
      var out: [BoardID: Read] = [:]
      for vb in unread {
        let stamp = [Self.stamp(vault.url(of: vb.path).appending(path: Vault.boardFileName)), shared]
        if have[vb.id]?.stamp == stamp { continue }
        let board = (try? vault.board(at: vb.path))?.inflated { try? vault.sharedCard($0) }
        out[vb.id] = Read(stamp: stamp, cards: board.map(Self.placed) ?? [])
      }
      return out
    }.value
    read.merge(fresh) { $1 }
    return b.all.map { vb in (vb, b.open[vb.id].map { Self.placed($0.board) } ?? read[vb.id]?.cards ?? []) }
  }

  nonisolated static func stamp(_ u: URL) -> Date? {
    (try? FileManager.default.attributesOfItem(atPath: u.path(percentEncoded: false)))?[.modificationDate] as? Date
  }

  /// Each open board's document heard: a change of its code cards (added, removed, changed, undone, merged from
  /// another window) is told to the code tabs
  func watch(_ open: [BoardID: BoardDocument]) {
    for (id, w) in watched where open[id].map(ObjectIdentifier.init) != w.doc {
      w.stop()
      watched[id] = nil
    }
    for (id, doc) in open where watched[id] == nil {
      let stop = doc.observe { [weak self, weak doc] _ in
        guard let self, let doc, let w = self.watched[id] else { return }
        let now = Self.placed(doc.board)
        guard now != w.cards else { return }
        self.watched[id]?.cards = now
        self.boardsChanged()
      }
      watched[id] = Watched(doc: ObjectIdentifier(doc), stop: stop, cards: Self.placed(doc.board))
    }
  }

  /// Tells the pane's code tabs, once for all the changes of this turn
  func boardsChanged() {
    guard !telling else { return }
    telling = true
    Task { @MainActor [weak self] in
      guard let self else { return }
      self.telling = false
      NotificationCenter.default.post(name: CodeReading.boardsChanged, object: self.pane)
    }
  }

  // MARK: A file's lines on boards

  func onBoards(_ f: CodeFile, text: String) async -> [CodeOnBoard] {
    let info = await repo(f.repository).info.value
    let all = await cards()
    let here = front
    let now = text.components(separatedBy: "\n")
    let head = info == nil ? nil : try? await git.headOf(info!.root)
    let key = text.hashValue
    var out: [CodeOnBoard] = []
    for (vb, cs) in all {
      for c in cs where Self.shows(c.segment, f, info) {
        let s = c.segment
        guard let at = await place(s, now: now, root: info?.root, head: head, key: key) else { continue }
        out.append(
          CodeOnBoard(
            board: vb.id, boardName: vb.title, here: vb.id == here, card: c.card, title: c.title, lines: at.lines,
            range: "\(s.firstLine)–\(s.lastLine)", commit: at.older.map { String($0.prefix(7)) }))
      }
    }
    return out
  }

  func go(to card: CodeOnBoard) { goTo(card.board, card.card) }

  /// Where a card's lines are in a file's lines `now` (read in git root `root`, at `head`), and the commit it is from
  /// when that is another: its recorded lines when it is of this version and they are there; else followed from its
  /// commit's text, or found by their text. `key`: the text's, for what was found before. `lazy`: a blobless clone may
  /// fetch the commit's file (a click; never for marks)
  func place(_ s: Segment, now: [String], root: String?, head: String?, key: Int, lazy: Bool = false) async -> (
    lines: ClosedRange<Int>, older: String?
  )? {
    let older = Self.older(s, head: head)
    var commit: String?
    var path = ""
    switch s.source {
    case .git(_, let c, let p, let uncommitted, _)?:
      if !uncommitted { commit = c }
      path = p
    case .file?, .package?: break
    case nil: return nil
    }
    if older == nil, sameLinesAt(s.firstLine, s.lines, in: now) { return (s.firstLine...s.lastLine, nil) }
    let k = LinesKey(text: key, source: "\(String(describing: s.source))", first: s.firstLine, lines: s.lines)
    if let hit = found[k] { return hit.map { ($0, older) } }
    let old: String? =
      if let commit, let root { await Self.show(git, root, commit, path, lazy: lazy) } else { nil }
    let start = s.firstLine
    let lines = s.lines
    let got = await Task.detached(priority: .userInitiated) { linesNow(start: start, lines: lines, old: old, in: now) }
      .value
    if found.count > 4000 { found = [:] }
    found[k] = got
    return got.map { ($0, older) }
  }

  /// The commit a card is from when the file is shown at another (`head`); nil for one of this version (its working
  /// copy too) and for a source of no commit
  nonisolated static func older(_ s: Segment, head: String?) -> String? {
    guard case .git(_, let c, _, false, _)? = s.source, head.map({ $0.hasPrefix(c) || c.hasPrefix($0) }) != true
    else { return nil }
    return c
  }

  /// A file at a commit; nil when the commit or the file is not here. Not fetched unless `lazy`; a commit that is no
  /// sha is not asked (git would read some as options)
  nonisolated static func show(_ git: GitCache, _ root: String, _ commit: String, _ path: String, lazy: Bool) async
    -> String?
  {
    guard (4...40).contains(commit.count), commit.allSatisfy(\.isHexDigit), !path.hasPrefix("-") else { return nil }
    let env = lazy ? [:] : ["GIT_NO_LAZY_FETCH": "1"]
    guard
      case .exited(0, let out, _)? = try? await git.runner.run(
        ["show", "\(commit):\(path)"], in: root, environment: env)
    else { return nil }
    return out
  }

  // MARK: A card's file opened

  /// What a card's file cannot be opened without, said at its name; or that its commit is being fetched
  struct Missing: Equatable {
    enum Offer: Equatable {
      /// Add the repository from GitHub, at the card's address
      case clone(String)
      /// Add the folder the card was read in
      case folder(String)
      /// Open the file as the repository has it now
      case current(CodeFile)
    }

    var message: String
    var offer: Offer?
    var busy = false
  }

  /// What a repository's answer leaves to say; nil: the commit was found. `current`: the card's file in the
  /// repository that lacks the commit
  static func missing(_ m: RepoMatch, commit: String, current: CodeFile?) -> Missing? {
    let short = String(commit.prefix(7))
    switch m {
    case .found: return nil
    case .commitMissing(let r):
      let name = RepositoriesModel.name(r)
      return Missing(
        message: r.remote == nil
          ? "Commit \(short) is not in \(name), which has no remote to fetch it from."
          : "Commit \(short) cannot be found in \(name), not even on its remote.",
        offer: current.map(Missing.Offer.current))
    case .notAdded(let address, let folder):
      if let folder {
        return Missing(
          message: "This card was read in \(folder), which is not added on this Mac.", offer: .folder(folder))
      }
      if let address, let gh = try? GitHubRepo(address: address) {
        return Missing(message: "\(gh.owner)/\(gh.name) is not added on this Mac.", offer: .clone(address))
      }
      if let address {
        return Missing(message: "\(address) is not added on this Mac. Clone it and add its folder.", offer: nil)
      }
      return Missing(
        message:
          "This card does not say which repository it is from, and no repository added on this Mac has commit \(short).",
        offer: nil)
    }
  }

  /// A card's file opened in the reading pane (a kept tab) at the card's lines; what keeps it from opening is told to
  /// `say`, as is a commit being fetched first (nil: nothing to say any more)
  func open(_ s: Segment, say: @escaping @MainActor (Missing?) -> Void) async {
    switch s.source {
    case .git(let repository, let commit, let path, _, let checkout)?:
      guard let repositories else { return say(Missing(message: "No repositories can be added on this Mac.")) }
      do {
        var m = try await repositories.locate(repository: repository, commit: commit, checkout: checkout, fetch: false)
        if case .commitMissing(let r) = m, r.remote != nil {
          say(Missing(message: "Fetching \(commit.prefix(7)) from \(RepositoriesModel.name(r))…", busy: true))
          m = try await repositories.locate(repository: repository, commit: commit, checkout: checkout)
        }
        switch m {
        case .found(let r, let root):
          say(nil)
          await show(s, in: Self.file(r, root: root, path: path), root: root)
        case .commitMissing(let r):
          let root = await repositories.root(of: r)
          say(Self.missing(m, commit: commit, current: root.map { Self.file(r, root: $0, path: path) }))
        case .notAdded:
          say(Self.missing(m, commit: commit, current: nil))
        }
      } catch {
        say(Missing(message: RepositoriesModel.words(error)))
      }
    case .file(let path, _)?:
      guard let abs = await repositories?.locateFile(path),
        let r = repositories?.list.first(where: { abs.hasPrefix($0.path + "/") })
      else { return say(Missing(message: "\(path) is in no repository added on this Mac.")) }
      say(nil)
      let f = CodeFile(
        repository: r.path, name: RepositoriesModel.name(r), path: String(abs.dropFirst(r.path.count + 1)))
      await show(s, in: f, root: nil)
    case .package(let name, let version, _)?:
      say(
        Missing(
          message: "This card's code is from \(name) \(version), an installed package, which is not opened here yet."))
    case nil: return
    }
  }

  /// The card's file in a kept tab, the card's lines located and marked; from another commit, the bar says which
  func show(_ s: Segment, in f: CodeFile, root: String?) async {
    let url = URL(filePath: f.repository, directoryHint: .isDirectory).appending(path: f.path)
    let text = await Task.detached { () -> String? in
      FileManager.default.contents(atPath: url.path(percentEncoded: false)).map {
        String(decoding: $0, as: UTF8.self).replacingOccurrences(of: "\r\n", with: "\n")
      }
    }.value
    let head = root == nil ? nil : try? await git.headOf(root!)
    var lines: ClosedRange<Int>?
    if let text {
      lines = await place(
        s, now: text.components(separatedBy: "\n"), root: root, head: head, key: text.hashValue, lazy: true)?
        .lines
    }
    let note = Self.older(s, head: head).map { c in
      lines == nil ? "Card from \(c.prefix(7)) · its lines are not in this version" : "Card from \(c.prefix(7))"
    }
    pane?.openCode(f, locating: lines, note: note)
  }

  /// The file at `path` from git root `root` in a repository: from the repository's folder when it is in it, else
  /// from the root
  static func file(_ r: Repository, root: String, path: String) -> CodeFile {
    let base = realPath(r.path)
    let abs = root + "/" + path
    let name = RepositoriesModel.name(r)
    if abs.hasPrefix(base + "/") {
      return CodeFile(repository: r.path, name: name, path: String(abs.dropFirst(base.count + 1)))
    }
    return CodeFile(repository: root, name: name, path: path)
  }

  /// An offer taken: the repository added, then the file opened again once it is (a clone once it is done); the file
  /// as it is now opened
  func take(_ o: Missing.Offer, lightweight: Bool, for s: Segment, say: @escaping @MainActor (Missing?) -> Void) async {
    guard let repositories else { return }
    switch o {
    case .clone(let address):
      if let why = repositories.addGitHub(address, lightweight: lightweight) { return say(Missing(message: why)) }
      say(nil)
      let key = (try? GitHubRepo(address: address)).map { repositoryKey("https://github.com/\($0.owner)/\($0.name)") }
      await repositories.clones.last { $0.key == key }?.task?.value
      if repositories.list.contains(where: { $0.remote.map(repositoryKey) == key }) { await open(s, say: say) }
    case .folder(let path):
      await repositories.addFolder(path)
      if let why = repositories.notice { return say(Missing(message: why)) }
      await open(s, say: say)
    case .current(let f):
      say(nil)
      await show(s, in: f, root: nil)
    }
  }
}

extension ShellCode {
  // MARK: ⌘K's functions and classes

  /// Those of every repository whose names are indexed so far (none is indexed for it: a code tab, or a repository
  /// opened in the sidebar, starts that), scored as the VS Code palette scores them (search.ts), the best 60
  func symbols(_ q: String) async -> [SearchPanel.Symbol] {
    let q = q.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !q.isEmpty else { return [] }
    var all: [(folder: String, root: String, name: String, entries: [IndexEntry])] = []
    var lookups: [String: (root: String, lookup: CodeLookup)] = [:]
    for (folder, r) in repos.sorted(by: { $0.key < $1.key }) {
      lookups[folder] = (r.root, r.sources.lookup)
      let name =
        repositories?.list.first { $0.path == folder }.map(RepositoriesModel.name)
        ?? URL(filePath: folder).lastPathComponent
      all.append((folder, r.root, name, await r.sources.lookup.index.indexedEntries()))
    }
    return await Task.detached(priority: .userInitiated) { Self.withCode(Self.ranked(q, all), lookups) }.value
  }

  /// Each one's first 30 lines, for the preview pane (as a code card's: fenced in its language); each file read once
  nonisolated static func withCode(
    _ syms: [SearchPanel.Symbol], _ repos: [String: (root: String, lookup: CodeLookup)]
  ) -> [SearchPanel.Symbol] {
    var files: [String: [String]] = [:]
    return syms.map { s in
      guard let r = repos[s.repository] else { return s }
      let abs = r.root + "/" + s.path
      let lines =
        files[abs]
        ?? FileManager.default.contents(atPath: abs).map {
          String(decoding: $0, as: UTF8.self).replacingOccurrences(of: "\r\n", with: "\n").components(separatedBy: "\n")
        } ?? []
      files[abs] = lines
      guard s.start >= 1, s.start <= lines.count else { return s }
      let text = lines[(s.start - 1)..<min(lines.count, max(s.start, s.end), s.start + 29)].joined(separator: "\n")
      let lang = r.lookup.langOf(abs)
      let ticks = text.contains("```") ? "````" : "```"
      var t = s
      t.preview = "\(ticks)\(lang == "plaintext" ? "" : lang)\n\(text)\n\(ticks)"
      return t
    }
  }

  nonisolated static func ranked(
    _ q: String, _ repos: [(folder: String, root: String, name: String, entries: [IndexEntry])]
  )
    -> [SearchPanel.Symbol]
  {
    let ql = q.lowercased()
    let many = repos.filter { !$0.entries.isEmpty }.count > 1
    var scored: [(s: Double, sym: SearchPanel.Symbol)] = []
    for r in repos {
      for e in r.entries {
        // a substring (of the name, or of the qualified name) first; a subsequence of the name only, close together
        let n = BoardSearch.fuzzy(q, e.name)
        let qual = e.qual.lowercased().contains(ql) ? BoardSearch.fuzzy(q, e.qual) : -1
        let s = max(n < 0 ? -1 : n + 5, qual)
        guard s >= 0, e.abs.hasPrefix(r.root + "/") else { continue }
        let rel = String(e.abs.dropFirst(r.root.count + 1))
        scored.append(
          (
            s,
            SearchPanel.Symbol(
              label: e.qual, detail: "\(many ? r.name + " › " : "")\(rel):\(e.defLine)", repository: r.folder,
              name: r.name, path: rel, start: e.start, line: e.defLine, end: e.end, isClass: e.kind == .class)
          ))
      }
    }
    // a stable sort, as JavaScript's
    return scored.enumerated().sorted { ($0.element.s, -$0.offset) > ($1.element.s, -$1.offset) }.prefix(60)
      .map(\.element.sym)
  }

  /// A function or class in a kept tab, its head located
  func open(_ s: SearchPanel.Symbol) {
    pane?.openCode(
      CodeFile(repository: s.repository, name: s.name, path: s.path), locating: s.start...max(s.start, s.line),
      note: nil)
  }

  /// A function or class whole to the board in front as a code card, as a code tab's Add Function makes it, the file
  /// not opened
  func add(_ s: SearchPanel.Symbol) async {
    let f = CodeFile(repository: s.repository, name: s.name, path: s.path)
    guard canAdd else { return NSSound.beep() }
    let url = URL(filePath: repo(s.repository).root, directoryHint: .isDirectory).appending(path: s.path)
    let text = await Task.detached { () -> String? in
      FileManager.default.contents(atPath: url.path(percentEncoded: false)).map {
        String(decoding: $0, as: UTF8.self).replacingOccurrences(of: "\r\n", with: "\n")
      }
    }.value
    let pick = text.map {
      CodePick(text: $0, lines: s.start...s.end, symbol: Symbol(name: s.label, kind: s.isClass ? .class : .function))
    }
    guard let pick, let seg = await segment(f, pick) else { return NSSound.beep() }
    pane?.onCollect?(CodeReading.collected(seg, of: f))
  }
}

extension BoardPanes {
  /// The vault's boards, the open ones' documents with them
  var vaultBoards: ShellCode.Boards? {
    shell.vault.map { ShellCode.Boards(vault: $0, all: shell.tree?.allBoards ?? [], open: documents) }
  }

  /// A code card's file name clicked on a canvas (CanvasView.onOpenCode): opened in the reading pane, or what is
  /// missing said in a popover at the name
  func openCodeSource(_ s: Segment, at r: CGRect, on canvas: CanvasView?) {
    guard let code = shell.reading.codeHost as? ShellCode else { return }
    let pop = SourcePopover(at: r, of: canvas)
    pop.take = { [weak code, weak pop] offer, lightweight in
      guard let code, let pop else { return }
      Task { await code.take(offer, lightweight: lightweight, for: s, say: pop.say) }
    }
    pop.model = code.repositories
    Task { await code.open(s, say: pop.say) }
  }

  /// A function or class picked in ⌘K: the palette closes, and it opens in the reading pane or goes to the board
  func pickedCode(_ s: SearchPanel.Symbol, add: Bool) {
    closeSearch()
    guard let code = shell.reading.codeHost as? ShellCode else { return }
    if add {
      Task { await code.add(s) }
    } else {
      code.open(s)
    }
  }

  /// A card's place: on the board in front, brought into view and selected; else in the tab showing its board, or a
  /// new tab
  func goToCard(_ board: BoardID, _ card: CardID) {
    if let t = shell.selected, let p = panes[t], p.document?.id == board { return p.canvas.arrive(at: card) }
    if let tab = shell.tabs.first(where: { $0.board == board }) {
      shell.select(tab.id)
      sync()
      guard let p = panes[tab.id] else { return }
      return p.document?.id == board ? p.canvas.arrive(at: card) : p.arriving(.card(card))
    }
    shell.show(board, newTab: true)
    sync()
    if let t = shell.selected { panes[t]?.arriving(.card(card)) }
  }
}

/// The popover at a card's file name saying what is missing to open it, with what it offers; one at a time
@MainActor final class SourcePopover {
  private let rect: CGRect
  private weak var view: NSView?
  var take: ((ShellCode.Missing.Offer, Bool) -> Void)?
  weak var model: RepositoriesModel?
  private static var shown: NSPopover?

  init(at r: CGRect, of view: NSView?) {
    rect = r
    self.view = view
  }

  func say(_ m: ShellCode.Missing?) {
    guard let m else {
      Self.shown?.close()
      Self.shown = nil
      return
    }
    guard let view, view.window != nil else { return }
    let content = NSHostingController(
      rootView: MissingSource(
        missing: m, model: model, close: { Self.shown?.close() },
        take: { [weak self] o, light in
          Self.shown?.close()
          self?.take?(o, light)
        }))
    if let p = Self.shown, p.isShown {
      p.contentViewController = content
      return
    }
    let p = NSPopover()
    p.behavior = .transient
    p.contentViewController = content
    p.show(relativeTo: rect, of: view, preferredEdge: .maxY)
    Self.shown = p
  }
}

/// What the popover says: why the file cannot be opened, and the one way on it offers (the sidebar's GitHub form for
/// a repository on GitHub)
struct MissingSource: View {
  let missing: ShellCode.Missing
  let model: RepositoriesModel?
  let close: () -> Void
  let take: (ShellCode.Missing.Offer, Bool) -> Void

  var body: some View {
    if case .clone(let address)? = missing.offer, let model {
      GitHubForm(
        model: model, address: address, title: missing.message, adding: { take(.clone($0), $1) }, done: close)
    } else {
      VStack(alignment: .leading, spacing: 10) {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
          if missing.busy { ProgressView().controlSize(.small) }
          Text(missing.message).font(.system(size: 12.5)).fixedSize(horizontal: false, vertical: true)
        }
        switch missing.offer {
        case .folder(let f)?:
          HStack {
            Spacer()
            Button("Add Folder") { take(.folder(f), false) }.keyboardShortcut(.defaultAction)
          }
        case .current(let f)?:
          HStack {
            Spacer()
            Button("Open at Current Commit") { take(.current(f), false) }.keyboardShortcut(.defaultAction)
          }
        case .clone?, nil: EmptyView()
        }
      }
      .padding(14)
      .frame(width: 300, alignment: .leading)
    }
  }
}
