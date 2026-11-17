import CodeBoardModel
import CodeBoardReading
import CodeBoardWorkspace
import Foundation
import os

// The vault's code annotations (CodeNotes) as the app keeps them: one store per vault, for every window's boards and
// code tabs, and the repository key of a card's source. A source with a remote URL has its key at once; one without
// has it once its repository is found on this Mac and its first commit read (a shallow clone without a remote has
// none: its annotations stay on its cards). A repository with a remote found here also has its first commit's key
// read, so that what was kept under it before it had a remote is taken in (CodeNotes.alias).

@MainActor final class CodeKeys {
  weak var repositories: RepositoriesModel?
  /// Told when a key became known, so that the boards take in what their cards have of it
  var learned: @MainActor () -> Void = {}
  /// By source (its remote, else where it was read and its commit): its key, nil when it has none
  private var known: [String: String?] = [:]
  private var asking: Set<String> = []
  private var listSeen: [Repository] = []
  /// Each remote's key whose repository's first commit was read here, with that commit's key
  private(set) var aliases: [String: String] = [:]

  func key(_ s: CodeSource) -> String? {
    guard case .git(let repository, let commit, _, _, let checkout) = s else { return nil }
    if let list = repositories?.list, list != listSeen {
      listSeen = list
      known = known.filter { $0.value != nil }
    }
    let k = repository.map { "remote\0\($0)" } ?? "local\0\(checkout ?? "")\0\(commit)"
    if let got = known[k], repository == nil { return got }
    if known[k] == nil, asking.insert(k).inserted {
      Task { await self.resolve(k, repository: repository, commit: commit, checkout: checkout) }
    }
    return repository.map(repositoryKey) ?? nil
  }

  private func resolve(_ k: String, repository: String?, commit: String, checkout: String?) async {
    defer { asking.remove(k) }
    var root: String?
    if let repositories, let git = repositories.git {
      switch try? await repositories.locate(repository: repository, commit: commit, checkout: checkout, fetch: false) {
      case .found(_, let r)?: root = r
      case .commitMissing(let r)?: root = await repositories.root(of: r)
      default: break
      }
      if let root {
        let remote = repository == nil ? ((try? await git.origin(root)) ?? nil) : repository
        let byRoot = await git.rootKey(root)
        if let remote, let byRoot { aliases[byRoot] = repositoryKey(remote) }
        known.updateValue(remote.map(repositoryKey) ?? byRoot, forKey: k)
      }
    }
    // not found: a source with a remote has its key anyway; one without has none until the repositories change
    if root == nil { known.updateValue(repository.map(repositoryKey), forKey: k) }
    learned()
  }
}

extension BoardDocuments {
  static let codeLog = Logger(subsystem: Bundle.main.bundleIdentifier ?? "CodeBoard", category: "annotations")

  /// The vault's code annotations, for its boards and code tabs; nil without a vault
  var code: CodeNotes? {
    guard let vault = session.vault else { return nil }
    if let c = codeStore, c.folder == CodeFiles.folder(vault) { return c }
    let keys = codeKeys
    let c = CodeNotes(
      vault: vault, key: { keys.key($0) },
      lineMap: { mapLines($0, $1, $2, $3) })
    c.onProblem = { Self.codeLog.error("\($0, privacy: .public)") }
    keys.learned = { [weak c, weak keys] in
      guard let c, let keys else { return }
      for (root, remote) in keys.aliases { c.alias(root, to: remote) }
      c.keysLearned()
    }
    codeStore = c
    return c
  }
}

// MARK: A code tab's annotations

extension ShellCode {
  /// Where a code tab's file's annotations are: the vault's store, the repository's key and the file's path in it
  func notesPlace(_ f: CodeFile) async -> (store: CodeNotes, key: String, path: String, info: GitInfo)? {
    guard let store = boards()?.notes, let info = await repo(f.repository).info.value else { return nil }
    if notesHeard?.store != ObjectIdentifier(store) {
      notesHeard?.stop()
      notesHeard = (ObjectIdentifier(store), store.observe { [weak self] in self?.boardsChanged() })
    }
    let byRoot = await git.rootKey(info.root)
    if let remote = info.remote, let byRoot { store.alias(byRoot, to: repositoryKey(remote)) }
    guard let key = info.remote.map(repositoryKey) ?? byRoot else { return nil }
    return (store, key, info.prefix + f.path, info)
  }

  func annotations(_ f: CodeFile, text: String) async -> CodeAnnotations {
    guard let (store, key, path, info) = await notesPlace(f) else { return CodeAnnotations() }
    let have = store.notes(key, path)
    let now = text.components(separatedBy: "\n")
    let head = try? await git.headOf(info.root)
    let k = text.hashValue
    func at(_ p: CodePlace) async -> ClosedRange<Int>? {
      if sameLinesAt(p.lines.lowerBound, p.text, in: now) { return p.lines }
      let s = Segment(
        id: SegmentID(rawValue: ""),
        source: .git(repository: nil, commit: p.commit ?? "", path: path, uncommitted: p.commit == nil, checkout: nil),
        language: "", firstLine: p.lines.lowerBound, lines: p.text)
      return await place(s, now: now, root: info.root, head: head ?? nil, key: k)?.lines
    }
    var out = CodeAnnotations()
    for h in have.highlights { if let l = await at(h.place) { out.highlights.append(.init(id: h.id, lines: l)) } }
    for n in have.sidenotes {
      if let l = await at(n.place) { out.notes.append(.init(id: n.id, lines: l, note: n.note)) }
    }
    return out
  }

  func annotate(_ f: CodeFile, _ pick: CodePick, note: String?, ask: Bool) async -> Bool {
    guard let (store, key, path, _) = await notesPlace(f), let seg = await segment(f, pick),
      let place = CodePlace(seg, pick.lines)
    else { return false }
    let now = (Date().timeIntervalSince1970 * 1000).rounded()
    let text = note?.trimmingCharacters(in: .whitespacesAndNewlines)
    store.change(key) { r in
      var file = r.files[path] ?? CodeFileNotes()
      if !file.highlights.contains(where: { $0.place.lines == place.lines && $0.place.text == place.text }) {
        file.highlights.append(CodeHighlight(id: Board.newID("h"), place: place, at: now))
      }
      if let text, !text.isEmpty {
        file.sidenotes.append(
          CodeSidenote(
            id: SidenoteID(rawValue: Board.newID("n")), place: place, text: text,
            question: ask ? Question(at: now) : nil))
      }
      r.files[path] = file
    }
    return true
  }

  func changeNote(_ f: CodeFile, _ id: SidenoteID, _ change: @escaping (TextNote) -> TextNote?) async {
    guard let (store, key, path, _) = await notesPlace(f) else { return }
    store.change(key) { r in
      guard let i = r.files[path]?.sidenotes.firstIndex(where: { $0.id == id }) else { return }
      let n = r.files[path]!.sidenotes[i]
      guard let t = change(n.note) else {
        r.files[path]!.sidenotes.remove(at: i)
        if r.files[path]!.isEmpty { r.files[path] = nil }
        return
      }
      r.files[path]!.sidenotes[i].text = t.text
      r.files[path]!.sidenotes[i].alwaysShow = t.alwaysShow
      r.files[path]!.sidenotes[i].question = t.question
    }
  }

  func remove(_ f: CodeFile, highlights: Set<String>, notes: Set<SidenoteID>) async {
    guard let (store, key, path, _) = await notesPlace(f) else { return }
    store.change(key) { r in
      r.files[path]?.highlights.removeAll { highlights.contains($0.id) }
      r.files[path]?.sidenotes.removeAll { notes.contains($0.id) }
      if r.files[path]?.isEmpty == true { r.files[path] = nil }
    }
  }
}
