import AppKit
import CodeBoardCanvas
import CodeBoardModel
import CodeBoardWorkspace
import CoreServices
import Observation
import SwiftUI
import os

// Which code cards of the boards a window shows have a newer version, and moving them to it (host versions.ts,
// watch.ts, boards.ts refreshStale; core commands/versions.ts; the board's DiffPop and new-version banner). A board is
// checked when a canvas shows it, its segments again when they change (an undo too), the segments of a file when it
// changes, and all when a repository's HEAD moves, after the host's pauses, each repository watched by one FSEvents
// stream. A segment whose repository or file is not on this Mac is not checked and shows no mark: what is missing is
// said when the user asks for its new version. Code that only moved is followed by the board itself, a change with no
// undo step that undo replays (as the host's "moved"); an Update is one undo step.

/// The host's pauses (watch.ts): git events gathered this long before HEAD is read again, file changes this long
enum VersionPause {
  static let git = Duration.milliseconds(600)
  static let recheck = Duration.milliseconds(500)
}

@MainActor final class ShellVersions {
  private weak var code: ShellCode?
  /// The window's canvases, each with the board it shows
  var shown: @MainActor () -> [(canvas: CanvasView, doc: BoardDocument)] = { [] }
  /// How a pause is waited for; tests wait for none
  var pause: @Sendable (Duration) async -> Void = { try? await Task.sleep(for: $0) }
  /// What the last check found of each board's segments
  private(set) var states: [BoardID: [SegmentID: VersionState]] = [:]
  private struct Watched {
    weak var doc: BoardDocument?
    var stop: () -> Void
    /// Each segment as it was checked last
    var checked: [SegmentID: Segment] = [:]
    /// Where each segment checked is: its file and its git root
    var files: [SegmentID: (abs: String, root: String)] = [:]
    var run: Task<Void, Never>?
  }

  private var boards: [BoardID: Watched] = [:]
  /// Where a source's repository is, once asked, until the list of repositories changes
  private struct Located {
    var repo: Repository?
    var root: String?
  }

  private var located: [String: Located] = [:]
  private var listSeen: [Repository] = []
  /// Each repository watched (its git root), what stops it, and its HEAD when last read
  private var watching: [String: () -> Void] = [:]
  private var heads: [String: String] = [:]
  private var gitDue: Set<String> = []
  private var filesDue: Set<String> = []
  private var gitWait: Task<Void, Never>?
  private var filesWait: Task<Void, Never>?
  /// The segments being followed by the board itself: no change to check again
  private var following = false
  /// The canvases whose banner was dismissed, until they show another board
  private var dismissed: [ObjectIdentifier: BoardID] = [:]
  private var banners: [ObjectIdentifier: NSHostingView<VersionBanner>] = [:]
  private static let log = Logger(subsystem: Bundle.main.bundleIdentifier ?? "CodeBoard", category: "versions")

  init(code: ShellCode) {
    self.code = code
    watchList()
  }

  private var repositories: RepositoriesModel? { code?.repositories }

  /// The list of repositories changed (one added or removed): every board is checked again, so a card whose
  /// repository went shows nothing, and one whose repository came shows what it has
  private func watchList() {
    withObservationTracking {
      _ = repositories?.list
    } onChange: { [weak self] in
      Task { @MainActor [weak self] in
        guard let self else { return }
        self.watchList()
        self.located = [:]
        for id in self.boards.keys { self.check(id) }
      }
    }
  }

  // MARK: The boards shown

  /// The window's canvases changed (a board opened in a tab, a tab closed): new boards are checked, boards no longer
  /// shown forgotten, and each canvas shows its board's marks
  func follow() {
    let now = shown()
    let ids = Set(now.map(\.doc.id))
    for (id, w) in boards where !ids.contains(id) || w.doc == nil {
      w.stop()
      w.run?.cancel()
      boards[id] = nil
      states[id] = nil
    }
    for (_, doc) in now where boards[doc.id] == nil {
      let stop = doc.observe { [weak self, weak doc] _ in
        guard let self, let doc, !self.following else { return }
        self.edited(doc)
      }
      boards[doc.id] = Watched(doc: doc, stop: stop)
      check(doc.id)
    }
    let roots = Set(boards.values.flatMap { $0.files.values.map(\.root) })
    for (root, stop) in watching where !roots.contains(root) {
      stop()
      watching[root] = nil
      heads[root] = nil
    }
    for (canvas, doc) in now { show(doc.id, on: canvas) }
  }

  /// A board's segments changed: those that are new or not as they were checked are checked again; gone ones forgotten
  private func edited(_ doc: BoardDocument) {
    guard let w = boards[doc.id] else { return }
    let now = Self.segments(doc.board)
    let changed = Set(now.filter { w.checked[$0.key] != $0.value }.keys)
    let gone = Set(w.checked.keys).subtracting(now.keys)
    for s in gone {
      boards[doc.id]?.checked[s] = nil
      boards[doc.id]?.files[s] = nil
      states[doc.id]?[s] = nil
    }
    if !changed.isEmpty { check(doc.id, only: changed) }
    push(doc.id)
  }

  /// A board's segments with a source, by id (a card placed twice on it has them once)
  static func segments(_ b: Board) -> [SegmentID: Segment] {
    var out: [SegmentID: Segment] = [:]
    for (_, code) in b.codeCards {
      for s in code.segments where s.source != nil { out[s.id] = s }
    }
    return out
  }

  /// Checks a board's segments (`only`: these), one check after another: an older check never ends after a newer one
  func check(_ id: BoardID, only: Set<SegmentID>? = nil) {
    guard let prev = boards[id] else { return }
    let before = prev.run
    boards[id]?.run = Task { [weak self] in
      await before?.value
      await self?.run(id, only: only)
    }
  }

  /// Waits for the checks asked for so far, and those they asked for (tests)
  func settled() async {
    while true {
      let runs = Set(boards.values.compactMap(\.run))
      for r in runs { await r.value }
      if Set(boards.values.compactMap(\.run)).isSubset(of: runs) { return }
    }
  }

  private func run(_ id: BoardID, only: Set<SegmentID>?) async {
    guard let doc = boards[id]?.doc else { return }
    let segs = Self.segments(doc.board).filter { only?.contains($0.key) ?? true }
    var locals: [SegmentID: Local] = [:]
    for (sid, s) in segs { if let l = await local(s) { locals[sid] = l } }
    // one check per repository folder's Sources
    var groups: [ObjectIdentifier: (Sources, [CodeSegment])] = [:]
    for l in locals.values { groups[ObjectIdentifier(l.sources), default: (l.sources, [])].1.append(l.seg) }
    var found: [String: Stale] = [:]
    do {
      for (sources, ss) in groups.values {
        let got = try await sources.staleFor(ss)
        found.merge(got) { $1 }
      }
    } catch {
      // no git: no marks (the repositories block says so)
      Self.log.error("version check failed: \(String(describing: error), privacy: .public)")
      found = [:]
    }
    guard !Task.isCancelled, let doc = boards[id]?.doc else { return }
    var st = states[id] ?? [:]
    var moved: [(SegmentID, Int, CodeSource)] = []
    for (sid, s) in segs {
      st[sid] = nil
      switch found[sid.rawValue] {
      case .changed(let hidden, let label)?: st[sid] = .changed(hiddenOnly: hidden, label: label)
      case .lost?: st[sid] = .lost
      case .many?: st[sid] = .many
      case .uncommitted?: st[sid] = .uncommitted
      case .moved(let start, _, let v)?:
        if let src = Self.source(s.source, v) { moved.append((sid, start, src)) }
      case .ok?, .missing?, nil: break
      }
    }
    if !moved.isEmpty {
      following = true
      doc.derive { Self.follow(&$0, moved) }
      following = false
    }
    let now = Self.segments(doc.board)
    for (sid, s) in segs {
      boards[id]?.checked[sid] = moved.contains { $0.0 == sid } ? now[sid] : s
      boards[id]?.files[sid] = locals[sid].map { ($0.abs, $0.root) }
    }
    states[id] = st
    push(id)
    for l in locals.values { await watch(l.root, sources: l.sources) }
  }

  /// core followMoved: code that only moved is followed to its lines there, pinned to the version it was found in
  static func follow(_ b: inout Board, _ moved: [(SegmentID, Int, CodeSource)]) {
    for (sid, start, src) in moved {
      for (cid, code) in b.codeCards {
        guard let seg = code.segments.first(where: { $0.id == sid }) else { continue }
        var ns = seg
        ns.firstLine = start
        ns.source = src
        let d = start - seg.firstLine
        b.rebaseSegment(cid, ns, map: { $0 + d })
      }
    }
  }

  /// A source at another version
  static func source(_ s: CodeSource?, _ v: SegmentVersion) -> CodeSource? {
    switch (s, v) {
    case (.git(let repository, _, let path, _, let checkout)?, .git(let commit, let uncommitted)):
      .git(repository: repository, commit: commit, path: path, uncommitted: uncommitted, checkout: checkout)
    case (.file(let path, _)?, .hash(let h)): .file(path: path, hash: h)
    case (.file(let path, _)?, .none): .file(path: path, hash: nil)
    case (.package(_, _, let path)?, .pkg(let name, let version)): .package(name: name, version: version, path: path)
    default: nil
    }
  }

  /// The marks a canvas shows, and its banner
  private func show(_ id: BoardID, on canvas: CanvasView) {
    let st = states[id] ?? [:]
    if canvas.versions != st { canvas.versions = st }
    let k = ObjectIdentifier(canvas)
    if let d = dismissed[k], d != id { dismissed[k] = nil }
    let n = dismissed[k] == nil ? (boards[id]?.doc?.board.staleCount(st) ?? 0) : 0
    banner(n, on: canvas)
  }

  private func push(_ id: BoardID) {
    for (canvas, doc) in shown() where doc.id == id { show(id, on: canvas) }
  }

  // MARK: Where a segment's code is

  /// A segment as the workspace checks it, the Sources of its repository folder, and where its file is
  struct Local {
    var seg: CodeSegment
    var sources: Sources
    var abs: String
    var root: String
  }

  /// Where a segment's code is on this Mac: a git source's repository as the repositories added here locate it (the
  /// commit fetched or not), a file source's file in one of them; nil: not here (a package's code neither)
  func local(_ s: Segment) async -> Local? {
    guard let code, let repositories else { return nil }
    if repositories.list != listSeen {
      listSeen = repositories.list
      located = [:]
    }
    switch s.source {
    case .git(let repository, let commit, let path, let uncommitted, let checkout)?:
      let key = "git\0\(repository ?? "")\0\(checkout ?? "")\0\(repository == nil ? commit : "")"
      if located[key] == nil {
        var at = Located()
        switch try? await repositories.locate(repository: repository, commit: commit, checkout: checkout, fetch: false)
        {
        case .found(let r, let root)?: at = Located(repo: r, root: root)
        case .commitMissing(let r)?: at = Located(repo: r, root: await repositories.root(of: r))
        default: break
        }
        located[key] = at
      }
      guard let r = located[key]?.repo, let root = located[key]?.root else { return nil }
      let seg = Self.workspace(s, root: root, path: path, version: .git(commit: commit, uncommitted: uncommitted))
      return Local(seg: seg, sources: code.repo(r.path).sources, abs: root + "/" + path, root: root)
    case .file(let path, let hash)?:
      guard let abs = await repositories.locateFile(path),
        let r = repositories.list.first(where: { abs.hasPrefix($0.path + "/") })
      else { return nil }
      let root =
        abs.hasSuffix("/" + path) ? String(abs.dropLast(path.count + 1)) : (abs as NSString).deletingLastPathComponent
      let rel = String(abs.dropFirst(root.count + 1))
      let seg = Self.workspace(s, root: root, path: rel, version: hash.map { .hash($0) } ?? .none)
      return Local(seg: seg, sources: code.repo(r.path).sources, abs: abs, root: r.path)
    case .package?, nil: return nil
    }
  }

  static func workspace(_ s: Segment, root: String, path: String, version: SegmentVersion) -> CodeSegment {
    CodeSegment(
      id: s.id.rawValue, src: .external(root: root), path: path, lang: s.language, start: s.firstLine, end: s.lastLine,
      text: s.lines, version: version, symbol: s.symbol.map(ShellCode.ref), scope: s.scope, hidden: s.hidden)
  }

  // MARK: Watching

  /// One stream per repository (RepoWatcher.place), HEAD read now
  private func watch(_ root: String, sources: Sources) async {
    guard watching[root] == nil else { return }
    watching[root] = {}
    let git = sources.git
    let at = await RepoWatcher.place(root, git: git)
    if let h = (try? await git.headOf(root)) ?? nil { heads[root] = h }
    guard watching[root] != nil else { return }
    watching[root] = RepoWatcher.listen(at.paths) { [weak self] changed in
      self?.repoChanged(root, gitDir: at.gitDir, changed, git: git)
    }
  }

  /// Files changed in a repository: HEAD, refs or its config (a commit, a checkout, a fetch) checks every board again
  /// once its HEAD moved; the rules of what git ignores changed, its answers are forgotten; any other file's segments
  /// are checked again
  func repoChanged(_ root: String, gitDir: String, _ paths: [String], git: GitCache) {
    let heard = RepoWatcher.sort(paths, root: root, gitDir: gitDir)
    filesDue.formUnion(heard.files)
    if heard.ignore { Task { await git.forgetIgnored() } }
    if heard.head {
      gitDue.insert(root)
      gitWait?.cancel()
      gitWait = Task { [weak self, pause] in
        await pause(VersionPause.git)
        guard !Task.isCancelled else { return }
        await self?.headsChanged(git)
      }
    }
    if !filesDue.isEmpty {
      filesWait?.cancel()
      filesWait = Task { [weak self, pause] in
        await pause(VersionPause.recheck)
        guard !Task.isCancelled else { return }
        self?.filesChanged()
      }
    }
  }

  private func headsChanged(_ git: GitCache) async {
    await git.forgetRepos()
    var moved = false
    for root in gitDue {
      let h = (try? await git.headOf(root)) ?? nil
      if h != heads[root] {
        moved = true
        heads[root] = h
      }
    }
    gitDue = []
    guard moved else { return }
    await git.forgetIgnored()
    located = [:]
    for id in boards.keys { check(id) }
  }

  private func filesChanged() {
    let paths = filesDue
    filesDue = []
    for (id, w) in boards {
      let ids = Set(w.files.filter { paths.contains($0.value.abs) }.keys)
      if !ids.isEmpty { check(id, only: ids) }
    }
  }

  // MARK: The user's asks

  /// A code card's version chip clicked: its new version (or HEAD against the working tree) in a popover at the chip,
  /// with Update and Duplicate as New Version; what keeps it from being had said there instead
  func ask(_ card: CardID, _ what: VersionAsk, at r: CGRect, on canvas: CanvasView) {
    guard let doc = canvas.document, let code = doc.board.codeCards.first(where: { $0.id == card })?.code else {
      return
    }
    let st = states[doc.id] ?? [:]
    let seg =
      what == .newVersion
      ? code.segments.first { if case .changed? = st[$0.id] { true } else { false } } ?? code.segments.first
      : code.segments.first
    guard let seg else { return }
    Task { await self.open(seg, card: card, worktree: what == .uncommitted, at: r, on: canvas, doc: doc) }
  }

  private func open(
    _ seg: Segment, card: CardID, worktree: Bool, at r: CGRect, on canvas: CanvasView, doc: BoardDocument.Seat
  ) async {
    let missing = SourcePopover(at: r, of: canvas)
    missing.model = repositories
    let code = self.code
    missing.take = { [weak self, weak code, weak missing, weak canvas] offer, light in
      guard let missing else { return }
      Task {
        await code?.take(offer, lightweight: light, for: seg, say: missing.say) {
          guard let self, let canvas else { return }
          await self.open(seg, card: card, worktree: worktree, at: r, on: canvas, doc: doc)
        }
      }
    }
    guard let local = await reach(seg, say: missing.say) else { return }
    do {
      let d = try await local.sources.diff(local.seg, worktree: worktree)
      VersionPopover.show(
        VersionDiffView(
          diff: d, impact: Self.impact(doc.board, card, seg.id),
          update: d.newSeg == nil ? nil : { [weak self] in self?.update(card, seg.id, to: d, in: doc, on: canvas) },
          duplicate: d.newSeg == nil ? nil : { [weak self] in self?.duplicate(card, seg.id, as: d, in: doc) },
          close: { VersionPopover.close() }),
        at: r, of: canvas)
    } catch {
      missing.say(ShellCode.Missing(message: RepositoriesModel.words(error)))
    }
  }

  /// The segment's code on this Mac, its commit fetched first when the repository lacks it (a clone, or a folder with
  /// a remote); else what is missing said (ShellCode.missing), with the offer to add the repository
  func reach(_ s: Segment, say: @escaping @MainActor (ShellCode.Missing?) -> Void) async -> Local? {
    guard let repositories else {
      say(ShellCode.Missing(message: "No repositories can be added on this Mac."))
      return nil
    }
    switch s.source {
    case .git(let repository, let commit, let path, _, let checkout)?:
      do {
        var m = try await repositories.locate(repository: repository, commit: commit, checkout: checkout, fetch: false)
        var fetched = false
        if case .commitMissing(let r) = m, r.remote != nil {
          say(ShellCode.Missing(message: "Fetching \(commit.prefix(7)) from \(RepositoriesModel.name(r))…", busy: true))
          m = try await repositories.locate(repository: repository, commit: commit, checkout: checkout)
          fetched = true
        }
        switch m {
        case .found:
          // what the check said without the commit (against HEAD, whatever came first) is said again with it
          if fetched { for id in boards.keys { check(id) } }
          guard let l = await local(s) else { return nil }
          say(nil)
          return l
        case .commitMissing(let r):
          let root = await repositories.root(of: r)
          say(ShellCode.missing(m, commit: commit, current: root.map { ShellCode.file(r, root: $0, path: path) }))
        case .notAdded:
          say(ShellCode.missing(m, commit: commit, current: nil))
        }
      } catch {
        say(ShellCode.Missing(message: RepositoriesModel.words(error)))
      }
      return nil
    case .file(let path, _)?:
      guard let l = await local(s) else {
        say(ShellCode.Missing(message: "\(path) is in no repository added on this Mac."))
        return nil
      }
      return l
    case .package(let name, let version, _)?:
      say(
        ShellCode.Missing(
          message: "This card's code is from \(name) \(version), an installed package, which is not opened here yet."))
      return nil
    case nil: return nil
    }
  }

  /// DiffPop's impact line: what moves with the lines on Update
  static func impact(_ b: Board, _ card: CardID, _ seg: SegmentID) -> String {
    let links = b.arrows.count { a in
      [a.from, a.to].contains { $0.card == card && $0.segment == seg && $0.line != nil }
    }
    let notes = b.sidenotes.count { n in
      if case .card(let c, let s?, _?, _) = n.anchor { c == card && s == seg } else { false }
    }
    let hl = b.segment(card, seg)?.highlights.count ?? 0
    let parts = [(hl, "highlight"), (links, "link"), (notes, "sidenote")].filter { $0.0 > 0 }.map {
      "\($0.0) \($0.1)\($0.0 > 1 ? "s" : "")"
    }
    guard !parts.isEmpty else { return "" }
    return
      "On update: \(parts.joined(separator: ", ")) move with their lines; anything on a removed line attaches to the whole card."
  }

  /// The model's segment at the diff's new version: its lines, where they are, its version
  static func updated(_ old: Segment, _ d: VersionDiff) -> Segment? {
    guard let ns = d.newSeg, let src = source(old.source, ns.version) else { return nil }
    var s = old
    s.firstLine = ns.start
    s.lines = ns.text
    s.source = src
    return s
  }

  /// Update: the segment to the new version, its lines followed, in one undo step; the sidenotes on lines that changed
  /// marked for a second look with the version's label
  @discardableResult
  func update(
    _ card: CardID, _ seg: SegmentID, to d: VersionDiff, in doc: BoardDocument.Seat, on canvas: CanvasView?
  ) -> Bool {
    guard let old = doc.board.segment(card, seg), let ns = Self.updated(old, d), let v = d.newSeg?.version else {
      return false
    }
    let map = mapLines(old.lines, old.firstLine, ns.lines, ns.firstLine)
    doc.edit("Update to New Version") { $0.rebaseSegment(card, ns, map: { map[$0] }, review: versionLabel(v)) }
    states[doc.id]?[seg] = nil
    boards[doc.id]?.checked[seg] = doc.board.segment(card, seg)
    push(doc.id)
    if let canvas {
      let n = doc.board.sidenotes.count { $0.anchor.card == card && $0.review != nil }
      let review = n > 0 ? " · \(n) sidenote\(n > 1 ? "s" : "") on changed lines, check \(n > 1 ? "them" : "it")" : ""
      canvas.toast("Updated to the new version\(review)")
    }
    return true
  }

  /// Duplicate as New Version: a copy of the card beside it, at the new version (its own ids), the old one kept
  func duplicate(_ card: CardID, _ seg: SegmentID, as d: VersionDiff, in doc: BoardDocument.Seat) {
    guard let c = doc.board.card(card), case .own(var k) = c.content, case .code(var code) = k.body,
      let i = code.segments.firstIndex(where: { $0.id == seg }), let ns = Self.updated(code.segments[i], d)
    else { return }
    let map = mapLines(code.segments[i].lines, code.segments[i].firstLine, ns.lines, ns.firstLine)
    code.segments[i] = Board.remapMarks(ns, code.segments[i], { map[$0] })
    for j in code.segments.indices { code.segments[j].id = SegmentID(rawValue: Board.newID("s")) }
    k.title = nil
    k.body = .code(code)
    let id = CardID(rawValue: Board.newID("c"))
    let copy = Card(id: id, x: c.x + c.width + 40, y: c.y, width: c.width, height: c.height, content: .own(k))
    doc.edit("Duplicate as New Version", selection: [.card(id)]) { $0.cards.append(copy) }
  }

  /// Update All in the banner: each card with a new version updated as Update does, one step each
  func updateAll(on canvas: CanvasView) async {
    guard let doc = canvas.document else { return }
    let st = states[doc.id] ?? [:]
    var todo: [(CardID, Segment)] = []
    for (cid, code) in doc.board.codeCards where code.version(st) == .changed {
      for s in code.segments { if case .changed? = st[s.id] { todo.append((cid, s)) } }
    }
    var n = 0
    for (cid, s) in todo {
      guard let l = await local(s), let d = try? await l.sources.diff(l.seg) else { continue }
      if update(cid, s.id, to: d, in: doc, on: nil) { n += 1 }
    }
    canvas.toast(
      n == todo.count
        ? "Updated \(n) card\(n == 1 ? "" : "s")" : "Updated \(n) of \(todo.count); open the others to review")
  }

  /// Review One by One: the next card with a new version brought into view and its diff opened at its chip
  func reviewNext(on canvas: CanvasView) async {
    guard let doc = canvas.document else { return }
    guard let id = doc.board.nextToReview(states[doc.id] ?? [:]) else {
      return canvas.toast("All cards are up to date")
    }
    canvas.arrive(at: id)
    guard let r = await canvas.versionChip(id) else { return }
    ask(id, .newVersion, at: r, on: canvas)
  }

  // MARK: The banner

  private func banner(_ n: Int, on canvas: CanvasView) {
    let k = ObjectIdentifier(canvas)
    guard n > 0 else {
      banners.removeValue(forKey: k)?.removeFromSuperview()
      return
    }
    let view = VersionBanner(
      count: n,
      review: { [weak self, weak canvas] in
        guard let canvas else { return }
        Task { await self?.reviewNext(on: canvas) }
      },
      updateAll: { [weak self, weak canvas] in
        guard let canvas else { return }
        Task { await self?.updateAll(on: canvas) }
      },
      dismiss: { [weak self, weak canvas] in
        guard let self, let canvas, let id = canvas.document?.id else { return }
        self.dismissed[ObjectIdentifier(canvas)] = id
        self.show(id, on: canvas)
      })
    let host = banners[k] ?? NSHostingView(rootView: view)
    host.rootView = view
    host.setAccessibilityIdentifier("versionBanner")
    if host.superview !== canvas {
      canvas.addSubview(host)
      banners[k] = host
    }
    let size = host.fittingSize
    // .banner: 52 from the top, in the middle
    host.frame = CGRect(
      x: ((canvas.bounds.width - size.width) / 2).rounded(),
      y: canvas.isFlipped ? 52 : canvas.bounds.height - 52 - size.height,
      width: size.width, height: size.height)
    host.autoresizingMask = [.minXMargin, .maxXMargin, canvas.isFlipped ? .maxYMargin : .minYMargin]
  }
}

/// The banner over a board with new versions (BoardView.tsx Banner, .banner.pill)
struct VersionBanner: View {
  let count: Int
  let review: () -> Void
  let updateAll: () -> Void
  let dismiss: () -> Void

  var body: some View {
    HStack(spacing: 8) {
      Circle().fill(Color(VersionColors.warn)).frame(width: 7, height: 7)
      Text("\(count) card\(count > 1 ? "s have" : " has") a new version").font(.system(size: 12.5))
      Button("Review One by One", action: review).buttonStyle(.borderless).font(.system(size: 12.5, weight: .medium))
      Button("Update All", action: updateAll).buttonStyle(.borderless).font(.system(size: 12.5, weight: .medium))
      Button(action: dismiss) {
        Image(systemName: "xmark").font(.system(size: 10, weight: .semibold)).frame(width: 22, height: 22)
      }
      .buttonStyle(.borderless).accessibilityLabel("Dismiss")
    }
    .foregroundStyle(Color(VersionColors.ink))
    .padding(.leading, 12).padding(.trailing, 3).padding(.vertical, 3)
    .frame(height: 32)
    .background(Capsule().fill(Color(VersionColors.glass)).shadow(color: .black.opacity(0.12), radius: 8, y: 4))
    .overlay(Capsule().strokeBorder(Color(VersionColors.ring), lineWidth: 0.5))
    .padding(10)
  }
}

/// Warm Ink's colours for the version popover and banner (themes.css :root: --warn, --chg, --chg-strong, --glass), its
/// dark ones in a dark appearance
enum VersionColors {
  static func pair(_ light: NSColor, _ dark: NSColor) -> NSColor {
    NSColor(name: nil) { $0.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua ? dark : light }
  }

  static func rgb(_ r: CGFloat, _ g: CGFloat, _ b: CGFloat, _ a: CGFloat = 1) -> NSColor {
    NSColor(srgbRed: r / 255, green: g / 255, blue: b / 255, alpha: a)
  }

  static let warn = pair(rgb(196, 138, 31), rgb(224, 176, 85))
  static let chg = pair(rgb(196, 138, 31, 0.13), rgb(224, 176, 85, 0.12))
  static let chgStrong = pair(rgb(196, 138, 31, 0.34), rgb(224, 176, 85, 0.32))
  static let glass = pair(rgb(253, 252, 250, 0.94), rgb(42, 41, 38, 0.94))
  static let ring = pair(rgb(60, 45, 20, 0.16), rgb(255, 240, 220, 0.11))
  static let ink = pair(rgb(33, 31, 27), rgb(236, 232, 224))
  static let ink3 = pair(rgb(143, 138, 128), rgb(140, 135, 125))
  static let hatch = pair(rgb(60, 45, 20, 0.07), rgb(255, 240, 220, 0.06))
  static let line = pair(rgb(60, 45, 20, 0.1), rgb(255, 240, 220, 0.1))
}

/// The version diff's popover, one at a time, at a card's chip
@MainActor enum VersionPopover {
  private static var shown: NSPopover?

  static func show(_ view: VersionDiffView, at r: CGRect, of v: NSView) {
    close()
    guard v.window != nil else { return }
    let p = NSPopover()
    p.behavior = .transient
    p.contentViewController = NSHostingController(rootView: view)
    p.show(relativeTo: r, of: v, preferredEdge: .maxY)
    shown = p
  }

  static func close() {
    shown?.close()
    shown = nil
  }
}

/// DiffPop: the pinned lines and the new version's side by side, aligned as Compare aligns them, the words that changed
/// marked, only two rows around each change shown; what moves on Update; Duplicate as New Version and Update
struct VersionDiffView: View {
  let diff: VersionDiff
  let impact: String
  let update: (() -> Void)?
  let duplicate: (() -> Void)?
  let close: () -> Void

  struct Row: Identifiable {
    var id: Int
    var kind: AlignRow.Kind?
    var l: Int?
    var r: Int?
    var lw: [Range<Int>] = []
    var rw: [Range<Int>] = []
    /// A run of same lines folded away: how many
    var gap = 0
  }

  /// DiffTable's rows: aligned on lines with their white space folded, the changed ones' words diffed; runs of same
  /// lines more than two from a change folded (none in fewer than 14 rows)
  static func rows(_ d: VersionDiff) -> [Row] {
    let norm = { (s: String) in
      s.trimmingCharacters(in: .whitespaces).split(whereSeparator: \.isWhitespace).joined(separator: " ")
    }
    let rs = alignRows(d.left.text.map(norm), d.right.text.map(norm))
    var keep = Set<Int>()
    for (i, r) in rs.enumerated() where r.kind != .same { keep.formUnion((i - 2)...(i + 2)) }
    var out: [Row] = []
    var i = 0
    while i < rs.count {
      if keep.contains(i) || rs.count < 14 {
        var row = Row(id: out.count, kind: rs[i].kind, l: rs[i].l, r: rs[i].r)
        if rs[i].kind == .changed, let l = rs[i].l, let r = rs[i].r {
          (row.lw, row.rw) = wordDiff(d.left.text[l], d.right.text[r])
        }
        out.append(row)
        i += 1
        continue
      }
      var j = i
      while j < rs.count && !keep.contains(j) { j += 1 }
      out.append(Row(id: out.count, gap: j - i))
      i = j
    }
    return out
  }

  var body: some View {
    VStack(spacing: 0) {
      HStack {
        Text(diff.title).font(.system(size: 13, weight: .semibold)).lineLimit(1)
        Spacer()
        Button(action: close) { Image(systemName: "xmark").font(.system(size: 11, weight: .semibold)) }
          .buttonStyle(.borderless).accessibilityLabel("Close")
      }
      .padding(.horizontal, 12).padding(.vertical, 8)
      if let note = diff.note { line(note) }
      HStack(spacing: 0) {
        column(diff.left)
        Divider()
        column(diff.right)
      }
      .frame(height: 26)
      Divider()
      ScrollView {
        LazyVStack(spacing: 0) {
          ForEach(Self.rows(diff)) { row in
            if row.gap > 0 {
              Text("⋯ \(row.gap) same lines").font(.system(size: 11)).foregroundStyle(Color(VersionColors.ink3))
                .frame(maxWidth: .infinity, minHeight: 22, alignment: .leading).padding(.leading, 50)
                .background(Color(VersionColors.hatch))
            } else {
              HStack(spacing: 0) {
                cell(diff.left, row.l, row.lw, on: row.kind == .changed || row.kind == .left)
                Divider()
                cell(diff.right, row.r, row.rw, on: row.kind == .changed || row.kind == .right)
              }
            }
          }
        }
        .padding(.top, 4).padding(.bottom, 8)
      }
      .frame(maxHeight: 460)
      if !impact.isEmpty { line(impact) }
      Divider()
      HStack(spacing: 6) {
        Button("Duplicate as New Version") {
          duplicate?()
          close()
        }.disabled(duplicate == nil)
        Spacer()
        Button(
          "Update to \(diff.right.label.hasPrefix("HEAD ") ? String(diff.right.label.dropFirst(5)) : diff.right.label)"
        ) {
          update?()
          close()
        }
        .keyboardShortcut(.defaultAction).disabled(update == nil)
      }
      .controlSize(.regular).padding(.horizontal, 10).padding(.vertical, 8)
    }
    .frame(width: 760)
  }

  private func line(_ s: String) -> some View {
    VStack(spacing: 0) {
      Text(s).font(.system(size: 11.5)).foregroundStyle(Color(VersionColors.ink3))
        .frame(maxWidth: .infinity, alignment: .leading).padding(.horizontal, 12).padding(.vertical, 5)
      Divider()
    }
  }

  private func column(_ s: DiffSide) -> some View {
    HStack(spacing: 8) {
      Text(s.label).font(.system(size: 11.5, weight: .semibold)).lineLimit(1)
      Text("\(s.path):\(s.start)").font(.system(size: 10.5, design: .monospaced))
        .foregroundStyle(Color(VersionColors.ink3)).lineLimit(1).truncationMode(.middle)
      Spacer(minLength: 0)
    }
    .padding(.horizontal, 12).frame(maxWidth: .infinity)
  }

  private func cell(_ s: DiffSide, _ i: Int?, _ words: [Range<Int>], on: Bool) -> some View {
    Group {
      if let i {
        HStack(spacing: 0) {
          Text("\(s.start + i)").font(.system(size: 11, design: .monospaced).monospacedDigit())
            .foregroundStyle(Color(VersionColors.ink3).opacity(0.65)).frame(width: 40, alignment: .trailing)
            .padding(.trailing, 10)
          Text(Self.marked(s.text[i], words)).font(.system(size: 11, design: .monospaced)).lineLimit(1)
            .truncationMode(.tail)
          Spacer(minLength: 0)
        }
      } else {
        Color(VersionColors.hatch)
      }
    }
    .frame(maxWidth: .infinity, minHeight: 20, maxHeight: 20, alignment: .leading)
    .background(on && i != nil ? Color(VersionColors.chg) : .clear).clipped()
  }

  /// A line with the words that changed on --chg-strong (mark.wdiff); offsets in UTF-16 units
  static func marked(_ line: String, _ words: [Range<Int>]) -> AttributedString {
    let u = Array(line.utf16)
    var out = AttributedString()
    var at = 0
    for w in words where w.lowerBound >= at && w.upperBound <= u.count {
      out += AttributedString(String(decoding: u[at..<w.lowerBound], as: UTF16.self))
      var m = AttributedString(String(decoding: u[w], as: UTF16.self))
      m.backgroundColor = Color(VersionColors.chgStrong)
      out += m
      at = w.upperBound
    }
    out += AttributedString(String(decoding: u[at...], as: UTF16.self))
    return out
  }
}

/// FSEvents on a repository's folders, per file: one stream for every listener in the app, stopped with the last
@MainActor final class RepoWatcher {
  private static var all: [String: RepoWatcher] = [:]
  private var listeners: [UUID: @MainActor ([String]) -> Void] = [:]
  private var stream: FSEventStreamRef?

  /// What to watch for a repository whose git root is `root`: its folder and, a worktree's, its git folder elsewhere;
  /// and that git folder (`root`/.git when git cannot say)
  static func place(_ root: String, git: GitCache) async -> (paths: [String], gitDir: String) {
    let gd = (try? await git.gitDirOf(root)) ?? nil
    return ([root] + (gd.map { $0.hasPrefix(root + "/") ? [] : [$0] } ?? []), gd ?? root + "/.git")
  }

  /// What a repository's watcher heard, sorted: its HEAD, refs or config changed (a commit, a checkout, a fetch); the
  /// rules of what git ignores changed; the repository's other files
  struct Heard {
    var head = false
    var ignore = false
    var files: [String] = []
  }

  static func sort(_ paths: [String], root: String, gitDir: String) -> Heard {
    var h = Heard()
    for p in paths {
      if p == gitDir || p.hasPrefix(gitDir + "/") {
        let g = p == gitDir ? "" : String(p.dropFirst(gitDir.count + 1))
        if g == "HEAD" || g == "packed-refs" || g == "config" || g.hasPrefix("refs/") { h.head = true }
        if g == "info/exclude" { h.ignore = true }
      } else if p.hasPrefix(root + "/") {
        if (p as NSString).lastPathComponent == ".gitignore" { h.ignore = true }
        h.files.append(p)
      }
    }
    return h
  }

  /// `f` hears the paths changed under `paths`; what is returned stops it
  static func listen(_ paths: [String], _ f: @escaping @MainActor ([String]) -> Void) -> () -> Void {
    let key = paths.joined(separator: "\0")
    let w = all[key] ?? RepoWatcher(paths)
    all[key] = w
    let id = UUID()
    w.listeners[id] = f
    return { [weak w] in
      MainActor.assumeIsolated {
        w?.listeners[id] = nil
        if w?.listeners.isEmpty == true { all[key] = nil }
      }
    }
  }

  private init(_ paths: [String]) {
    var context = FSEventStreamContext(
      version: 0, info: Unmanaged.passUnretained(self).toOpaque(), retain: nil, release: nil, copyDescription: nil)
    let callback: FSEventStreamCallback = { _, info, _, paths, _, _ in
      guard let info, let list = Unmanaged<CFArray>.fromOpaque(paths).takeUnretainedValue() as? [String] else {
        return
      }
      // The stream runs on the main queue (below)
      MainActor.assumeIsolated {
        let w = Unmanaged<RepoWatcher>.fromOpaque(info).takeUnretainedValue()
        for f in w.listeners.values { f(list) }
      }
    }
    guard
      let stream = FSEventStreamCreate(
        nil, callback, &context, paths as CFArray, FSEventStreamEventId(kFSEventStreamEventIdSinceNow), 0.1,
        FSEventStreamCreateFlags(kFSEventStreamCreateFlagFileEvents | kFSEventStreamCreateFlagUseCFTypes))
    else { return }
    FSEventStreamSetDispatchQueue(stream, .main)
    FSEventStreamStart(stream)
    self.stream = stream
  }

  isolated deinit {
    guard let stream else { return }
    FSEventStreamStop(stream)
    FSEventStreamInvalidate(stream)
    FSEventStreamRelease(stream)
  }
}

extension BoardPanes {
  /// The window's canvases, each with the board it shows
  var shownBoards: [(canvas: CanvasView, doc: BoardDocument)] {
    panes.values.compactMap { p in p.document.map { (p.canvas, $0) } }
  }
}
