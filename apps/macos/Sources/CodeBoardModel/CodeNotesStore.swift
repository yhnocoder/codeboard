import Foundation

/// A vault's code annotations as the app has them: every repository's file read once, changed in memory and written a
/// moment later (`flush` at once), each open board and code tab told of every change. Reading never writes: two files
/// of one repository are one in memory until the next change of it writes them as one (`CodeFiles.write`). Writing
/// takes in first what another writer added to the file since it was read here.
@MainActor public final class CodeNotes {
  public let folder: URL
  /// A git source's repository key (FORMAT.md, Code annotations); nil: none known (no remote and not found on this
  /// Mac, a shallow clone without a remote, not git): its annotations stay on the card
  public var key: (CodeSource) -> String?
  /// An old segment's lines' new lines in a new one (CodeBoardWorkspace's mapLines)
  public var lineMap: (_ old: [String], _ oldStart: Int, _ new: [String], _ newStart: Int) -> [Int: Int]
  /// What could not be read or written, said for the log
  public var onProblem: (String) -> Void = { _ in }
  /// Bumped by every change: a board that saw this one has nothing to take in
  public private(set) var generation = 0

  private var repos: [String: RepositoryNotes] = [:]
  /// The files holding each key, sorted: the first is where it is written
  private var files: [String: [String]] = [:]
  /// Each file as last read or written here
  private var base: [String: CodeFiles.File] = [:]
  /// Keys with a file this build does not write (a newer one): never written
  private var readOnly: Set<String> = []
  /// A repository's `root:` key under its remote's, once both are known
  private var aliases: [String: String] = [:]
  private var dirty: Set<String> = []
  private var observers: [UUID: @MainActor () -> Void] = [:]
  private var holding = 0
  private var held = false
  private var saving: Task<Void, Never>?

  public init(
    folder: URL, key: @escaping (CodeSource) -> String?,
    lineMap: @escaping ([String], Int, [String], Int) -> [Int: Int]
  ) {
    self.folder = folder
    self.key = key
    self.lineMap = lineMap
    reload()
  }

  public convenience init(
    vault: Vault, key: @escaping (CodeSource) -> String?,
    lineMap: @escaping ([String], Int, [String], Int) -> [Int: Int]
  ) {
    self.init(folder: CodeFiles.folder(vault), key: key, lineMap: lineMap)
  }

  /// A file's annotations
  public func notes(_ key: String, _ path: String) -> CodeFileNotes { repos[key]?.files[path] ?? CodeFileNotes() }

  /// A repository's annotations, every file's
  public func repository(_ key: String) -> RepositoryNotes { repos[key] ?? RepositoryNotes(repository: key) }

  /// Every repository key there are annotations of
  public var keys: [String] { repos.keys.sorted() }

  /// A repository's annotations changed, written a moment later; nothing when it changes nothing
  public func change(_ key: String, _ f: (inout RepositoryNotes) -> Void) {
    var n = repos[key] ?? RepositoryNotes(repository: key)
    f(&n)
    guard n != (repos[key] ?? RepositoryNotes(repository: key)) else { return }
    repos[key] = n
    dirty.insert(key)
    changed()
    scheduleSave()
  }

  /// `key` gives keys it did not give before: every board takes in what its cards have of them
  public func keysLearned() { changed() }

  /// The changes `f` makes told once, at its end
  public func batch(_ f: () -> Void) {
    holding += 1
    f()
    holding -= 1
    if holding == 0, held {
      held = false
      tell()
    }
  }

  private func changed() {
    generation += 1
    if holding > 0 { held = true } else { tell() }
  }

  private func tell() { for o in observers.values { o() } }

  /// Called after every change; returns what stops it
  public func observe(_ f: @escaping @MainActor () -> Void) -> () -> Void {
    let id = UUID()
    observers[id] = f
    return { [weak self] in self?.observers[id] = nil }
  }

  /// A repository's `root:` key is `key` (its remote's): what is filed under it is that repository's, in memory; written
  /// under `key`, the old file moved aside, with the repository's next change
  public func alias(_ root: String, to key: String) {
    guard root != key, aliases[root] != key else { return }
    aliases[root] = key
    guard let r = repos.removeValue(forKey: root) else { return }
    var n = repos[key] ?? RepositoryNotes(repository: key)
    n.take(r, from: files[root]?.first ?? root)
    repos[key] = n
    files[key] = ((files[key] ?? []) + (files.removeValue(forKey: root) ?? [])).sorted()
    if readOnly.remove(root) != nil { readOnly.insert(key) }
    if dirty.remove(root) != nil { dirty.insert(key) }
    changed()
  }

  private func scheduleSave() {
    saving?.cancel()
    saving = Task { [weak self] in
      try? await Task.sleep(for: BoardDocument.saveDelay)
      guard !Task.isCancelled else { return }
      try? self?.flush()
    }
  }

  // MARK: Disk

  /// The files read again; a repository changed here and not written yet keeps what it has (its writing takes in what
  /// came meanwhile)
  public func reload() {
    CodeFiles.lock.lock()
    var problems: [String] = []
    let read = CodeFiles.read(folder, problems: &problems)
    CodeFiles.lock.unlock()
    for p in problems { onProblem(p) }
    var byKey: [String: [CodeFiles.File]] = [:]
    for f in read {
      guard let k = f.key else { continue }
      byKey[aliases[k] ?? k, default: []].append(f)
    }
    var now: [String: RepositoryNotes] = [:]
    for (k, fs) in byKey where !dirty.contains(k) {
      var n = RepositoryNotes(repository: k)
      for f in fs { if let r = f.notes { n.take(r, from: f.name) } }
      now[k] = n
    }
    let before = repos
    for k in Set(repos.keys).union(now.keys) where !dirty.contains(k) {
      repos[k] = now[k]
      files[k] = byKey[k]?.map(\.name)
      if byKey[k]?.contains(where: { $0.notes == nil }) == true { readOnly.insert(k) } else { readOnly.remove(k) }
    }
    for f in read { base[f.name] = f }
    if repos != before { changed() }
  }

  /// Every repository changed here written now: into the first of its files (the others moved aside), after taking in
  /// what was added to them since they were read here. A repository with a file this build cannot write is not
  public func flush() throws {
    saving?.cancel()
    saving = nil
    guard !dirty.isEmpty else { return }
    CodeFiles.lock.lock()
    defer { CodeFiles.lock.unlock() }
    var problems: [String] = []
    let disk = CodeFiles.read(folder, problems: &problems)
    var failure: Error?
    for k in dirty.sorted() {
      let mine = disk.filter { f in f.key.map { aliases[$0] ?? $0 } == k }
      guard !readOnly.contains(k), !mine.contains(where: { $0.notes == nil }) else {
        onProblem("annotations of \(k) are not written: one of its files is from a newer CodeBoard")
        dirty.remove(k)
        continue
      }
      var n = repos[k] ?? RepositoryNotes(repository: k)
      // what another writer added since it was read here
      for f in mine where f.data != base[f.name]?.data {
        guard let theirs = f.notes else { continue }
        let was = base[f.name]?.notes
        var added = RepositoryNotes(repository: k)
        for (path, fn) in theirs.files {
          let h = fn.highlights.filter { h in was?.has(highlight: h.id) != true && !n.has(highlight: h.id) }
          let s = fn.sidenotes.filter { s in was?.has(sidenote: s.id) != true && !n.has(sidenote: s.id) }
          if !h.isEmpty || !s.isEmpty { added.files[path] = CodeFileNotes(highlights: h, sidenotes: s) }
        }
        n.take(added, from: f.name)
      }
      n.repository = k
      let names = (Set(mine.map(\.name)).union(files[k] ?? [])).sorted()
      let existing = names.filter { name in mine.contains { $0.name == name } }
      do {
        let (name, data) = try CodeFiles.write(
          n, into: existing.first, aside: Array(existing.dropFirst()), folder: folder)
        if let data {
          base[name] = CodeFiles.File(name: name, data: data, notes: n, key: k)
          files[k] = [name]
        } else {
          base[name] = nil
          files[k] = nil
        }
        for old in existing.dropFirst() { base[old] = nil }
        if repos[k] != n {
          repos[k] = n
          changed()
        }
        dirty.remove(k)
      } catch {
        failure = failure ?? error
        problems.append("\(folder.path(percentEncoded: false)): annotations of \(k) cannot be written: \(error)")
      }
    }
    for p in problems { onProblem(p) }
    if let failure { throw failure }
  }
}
