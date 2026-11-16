import CodeBoardAnalysis
import Foundation

// The workspace's index of symbol names, as packages/host/src/nameindex.ts has it: finding a definition by name when
// the language service gives none, and ⌘K's symbol search. Not built on a click: once a board is open it is built in
// the background, file by file (yielding between files), and a file saved, created, deleted or changed outside is done
// again on its own. A lookup by name before it is built reads only the files not analysed yet whose text has the name,
// so a click does not wait for the whole index. No limit on the number of files.

/// A function or class the index found
public struct IndexEntry: Hashable, Sendable {
  public var name: String
  public var qual: String
  public var kind: Sym.Kind
  public var abs: String
  public var start: Int
  public var end: Int
  public var defLine: Int
  public var sig: String

  public init(
    name: String, qual: String, kind: Sym.Kind, abs: String, start: Int, end: Int, defLine: Int, sig: String
  ) {
    self.name = name
    self.qual = qual
    self.kind = kind
    self.abs = abs
    self.start = start
    self.end = end
    self.defLine = defLine
    self.sig = sig
  }
}

/// A file's entries; nil while it is not analysed yet
public struct IndexedFile: Hashable, Sendable {
  public var abs: String
  public var entries: [IndexEntry]?
}

/// A file and its text
public struct FileText: Hashable, Sendable {
  public var abs: String
  public var text: String
}

/// Only against accidents (a repository of hundreds of thousands of code files)
let maxFiles = 500_000
/// Bigger files (generated code) are not analysed, in UTF-16 code units
let maxText = 2_000_000
/// How many files a lookup reads at once
let parallel = 16

// The words of a text as a 4096-bit map, one bit per identifier by its FNV hash: false hits, never misses. Word
// characters are ASCII, so walking UTF-8 sets the bits that walking UTF-16 code units sets.

let sigBits: UInt32 = 4096

struct WordSig: Sendable {
  private(set) var words = [UInt32](repeating: 0, count: Int(sigBits / 32))

  init(_ text: String) {
    var h: UInt32 = 0
    var inWord = false
    var t = text
    t.withUTF8 { buf in
      for c in buf {
        if isWordChar(c) {
          h = ((inWord ? h : 2_166_136_261) ^ UInt32(c)) &* 16_777_619
          inWord = true
        } else if inWord {
          set(h)
          inWord = false
        }
      }
    }
    if inWord { set(h) }
  }

  private mutating func set(_ h: UInt32) {
    let b = h % sigBits
    words[Int(b >> 5)] |= 1 << (b & 31)
  }

  func has(_ name: String) -> Bool {
    var h: UInt32 = 2_166_136_261
    for c in name.utf8 { h = (h ^ UInt32(c)) &* 16_777_619 }
    let b = h % sigBits
    return words[Int(b >> 5)] & (1 << (b & 31)) != 0
  }
}

private func isWordChar(_ c: UInt8) -> Bool {
  (c >= 97 && c <= 122) || (c >= 65 && c <= 90) || (c >= 48 && c <= 57) || c == 95
}

/// /^[A-Za-z_]\w*$/
func isIdent(_ s: String) -> Bool {
  guard let first = s.utf8.first, isWordChar(first), !(first >= 48 && first <= 57) else { return false }
  return s.utf8.allSatisfy(isWordChar)
}

/// JavaScript's includes: a match of UTF-8 bytes is a match of the same scalars, as one of UTF-16 code units is
func textContains(_ text: String, _ part: String) -> Bool {
  var t = text
  var p = part
  return t.withUTF8 { h in
    p.withUTF8 { n in
      guard let first = n.first else { return true }
      guard h.count >= n.count else { return false }
      var i = 0
      while i <= h.count - n.count {
        if h[i] == first {
          var k = 1
          while k < n.count && h[i + k] == n[k] { k += 1 }
          if k == n.count { return true }
        }
        i += 1
      }
      return false
    }
  }
}

/// A set that remembers the order its elements came in, as JavaScript's Set does
struct InsertionSet {
  private var stamps: [String: Int] = [:]
  private var queue: [(element: String, stamp: Int)] = []
  private var head = 0
  private var next = 0

  var isEmpty: Bool { stamps.isEmpty }
  func contains(_ x: String) -> Bool { stamps[x] != nil }

  mutating func insert(_ x: String) {
    guard stamps[x] == nil else { return }
    next += 1
    stamps[x] = next
    queue.append((x, next))
  }

  mutating func remove(_ x: String) { stamps[x] = nil }

  /// The oldest element
  mutating func first() -> String? {
    while head < queue.count && stamps[queue[head].element] != queue[head].stamp { head += 1 }
    if head > 1024 && head * 2 > queue.count {
      queue.removeFirst(head)
      head = 0
    }
    return head < queue.count ? queue[head].element : nil
  }

  /// Oldest first
  var elements: [String] { queue[head...].filter { stamps[$0.element] == $0.stamp }.map(\.element) }
}

// An actor: lookups, the background build and the owner's file events interleave at its awaits as they do on the
// TypeScript host's one thread, and an analysis in progress holds up only the index
public actor NameIndex {
  private let ws: any CodeWorkspace
  private let analysis: AnalysisCache
  private let sched: Scheduler

  /// File → its place in the list: results are in this order (a name's candidates keep their order)
  private var order: [String: Int] = [:]
  /// The files of order, in its order
  private var files: [String] = []
  private var seq = 0
  private var byFile: [String: [IndexEntry]] = [:]
  private var byName: [String: [IndexEntry]] = [:]
  /// allNames' answer, kept until an entry changes: ⌘K asks it on every keystroke
  private var names: [[IndexEntry]]?
  /// Listed (or changed) and not analysed yet
  private var todo = InsertionSet()
  /// The words of files read: of the ones not analysed yet, so that a lookup reads each once; of the analysed ones,
  /// for grepWord
  private var sigs: [String: WordSig] = [:]
  /// One more on every reset: work of an older generation stops when it sees it
  private var gen = 0
  /// One more on every change of a file: an analysis it overtook is not kept
  private var stamps: [String: Int] = [:]
  private var listing: Task<Void, Never>?
  private var running: Task<Void, Never>?
  /// Someone asked for the background build (a board was opened): changed files are done in the background too
  private var wanted = false
  private var timer: Task<Void, Never>?
  private var disposed = false
  private var warm: (@Sendable () async -> Void)?

  /// sched: whose higher priorities the background build waits for, between files
  public init(_ ws: any CodeWorkspace, analysis: AnalysisCache, sched: Scheduler) {
    self.ws = ws
    self.analysis = analysis
    self.sched = sched
  }

  /// Work that runs before each background build starts, such as another index reading the files it needs first (the
  /// host's PyTorch operator index); file events and resets reach it from the owner, as they reach this index
  public func beforeBuild(_ work: @escaping @Sendable () async -> Void) { warm = work }

  /// A file the index reads: the rule of FileQuery.code (an extension with a grammar, below no excluded folder)
  public nonisolated func isCode(_ abs: String) -> Bool {
    grammarOfFile(abs) != nil && !FileQuery.code.excludes(abs, root: ws.rootOf(abs))
  }

  private func place(_ abs: String) {
    guard order[abs] == nil else { return }
    order[abs] = seq
    seq += 1
    files.append(abs)
  }

  private func drop(_ abs: String) {
    names = nil
    for e in byFile[abs] ?? [] {
      guard let l = byName[e.name] else { continue }
      let rest = l.filter { $0.abs != abs }
      byName[e.name] = rest.isEmpty ? nil : rest
    }
    byFile[abs] = nil
  }

  /// Lists the workspace's code files, once (again after a reset)
  private func list() async {
    if let listing { return await listing.value }
    let g = gen
    let t = Task { await listFiles(g) }
    listing = t
    await t.value
  }

  private func listFiles(_ g: Int) async {
    let found = await ws.findFiles(.code, max: maxFiles)
    guard g == gen else { return }
    for f in found where order[f] == nil {
      place(f)
      if byFile[f] == nil { todo.insert(f) }
    }
    if found.count >= maxFiles {
      ws.log(.warn, "name index: more than \(maxFiles) code files, the rest are not indexed")
    }
  }

  private func indexFile(_ abs: String, text given: String? = nil) async {
    let g = gen
    let st = stamps[abs]
    let read: String?
    if let given { read = given } else { read = await ws.readText(abs) }
    guard g == gen, st == stamps[abs] else { return }
    let text = read.flatMap { $0.utf16.count < maxText ? $0 : nil }
    let ents = (text.map { analysis.symbolsOf(ws.langOf(abs), $0) } ?? []).map {
      IndexEntry(
        name: $0.name, qual: $0.qual, kind: $0.kind, abs: abs, start: $0.start, end: $0.end, defLine: $0.defLine,
        sig: $0.sig)
    }
    drop(abs)
    todo.remove(abs)
    // analysed files keep their words too: grepWord need not read them again
    sigs[abs] = text.map(WordSig.init)
    place(abs)
    byFile[abs] = ents
    for e in ents { byName[e.name, default: []].append(e) }
  }

  /// The background build: one at a time, until todo is empty
  private func drainTask() -> Task<Void, Never> {
    if let running { return running }
    let g = gen
    let t = Task { await drainTodo(g) }
    running = t
    return t
  }

  private func drainTodo(_ g: Int) async {
    defer { if g == gen { running = nil } }
    await list()
    while !todo.isEmpty && g == gen && !Task.isCancelled {
      // clicks, prefetches and warm-ups first (the file being analysed is finished)
      await sched.clear(.index)
      guard g == gen, !Task.isCancelled, let abs = todo.first() else { break }
      // a file changed during its analysis stays in todo, for the next round
      await indexFile(abs)
      await Task.yield()
    }
  }

  /// After a board opened: the background build starts, after delay (the board does its own work first)
  public func start(after delay: Duration = .zero) {
    if disposed { return }
    wanted = true
    timer?.cancel()
    timer = nil
    guard delay > .zero else { return go() }
    timer = Task {
      guard (try? await Task.sleep(for: delay)) != nil, !Task.isCancelled else { return }
      go()
    }
  }

  private func go() {
    timer = nil
    let warm = warm
    Task {
      await warm?()
      if !disposed { await drainTask().value }
    }
  }

  /// The whole index built (⌘K's symbol search wants every name)
  public func ready() async {
    await list()
    while !todo.isEmpty { await drainTask().value }
  }

  /// In list order, a file's entries in their order
  private func sorted(_ ents: [IndexEntry]) -> [IndexEntry] {
    ents.enumerated().sorted { a, b in
      let (oa, ob) = (order[a.element.abs] ?? 0, order[b.element.abs] ?? 0)
      return oa != ob ? oa < ob : a.offset < b.offset
    }.map(\.element)
  }

  /// The functions and classes of this name, without waiting for the whole index: of the files not analysed yet, only
  /// those whose text has the name are
  public func lookupName(_ name: String) async -> [IndexEntry] {
    await list()
    let g = gen
    let ident = isIdent(name)
    // a file read once is known by its words; one not read yet is read once and its words kept
    var pend = todo.elements.filter { f in !ident || sigs[f].map { $0.has(name) } ?? true }
    var round = 0
    while !pend.isEmpty && round < 3 && g == gen {
      // files that changed while they were read are read again
      var again: [String] = []
      var i = 0
      while i < pend.count && g == gen {
        let batch = Array(pend[i..<min(i + parallel, pend.count)])
        let st = batch.map { stamps[$0] }
        let texts = await readAll(batch)
        for (k, f) in batch.enumerated() {
          if st[k] != stamps[f] {
            if todo.contains(f) { again.append(f) }
            continue
          }
          guard let t = texts[k], todo.contains(f), g == gen else { continue }
          if textContains(t, name) {
            await indexFile(f, text: t)
          } else if t.utf16.count < maxText {
            sigs[f] = WordSig(t)
          }
        }
        i += parallel
      }
      pend = again
      round += 1
    }
    // asked for: the rest is built in the background
    if !wanted { start(after: .seconds(1)) }
    return sorted(byName[name] ?? [])
  }

  /// The entries of this name in the files analysed already; no file is read or analysed
  public func knownEntries(_ name: String) -> [IndexEntry] { sorted(byName[name] ?? []) }

  private nonisolated func readAll(_ files: [String]) async -> [String?] {
    await withTaskGroup(of: (Int, String?).self) { group in
      for (i, f) in files.enumerated() { group.addTask { [ws] in (i, await ws.readText(f)) } }
      var out = [String?](repeating: nil, count: files.count)
      for await (i, t) in group { out[i] = t }
      return out
    }
  }

  /// The code files whose text has this word, with their texts (registrations across languages, macro definitions,
  /// searching by name): the words kept rule files out (false hits, no misses), reading confirms; a file not read yet
  /// is read once and its words kept. grammar: only files of this grammar
  public func grepWord(_ word: String, grammar: Grammar? = nil) async -> [FileText] {
    await list()
    let g = gen
    let ident = isIdent(word)
    let pick = files.filter { f in
      (grammar == nil || grammarOfFile(f) == grammar) && (!ident || sigs[f].map { $0.has(word) } ?? true)
    }
    var out: [FileText] = []
    var i = 0
    while i < pick.count && g == gen {
      let batch = Array(pick[i..<min(i + parallel, pick.count)])
      for (f, t) in zip(batch, await readAll(batch)) {
        guard let t, t.utf16.count < maxText else { continue }
        if sigs[f] == nil { sigs[f] = WordSig(t) }
        if textContains(t, word) { out.append(FileText(abs: f, text: t)) }
      }
      i += parallel
    }
    return out
  }

  /// Every entry, by name (⌘K), once the whole index is built; names in the order of their first entry
  public func allNames() async -> [[IndexEntry]] {
    await ready()
    if let names { return names }
    let all = byName.values.map(sorted).map { l in
      (l, order[l[0].abs] ?? 0, byFile[l[0].abs]?.firstIndex(of: l[0]) ?? 0)
    }
    let out = all.sorted { a, b in a.1 != b.1 ? a.1 < b.1 : a.2 < b.2 }.map(\.0)
    names = out
    return out
  }

  /// The entries of the files analysed so far, in list order (⌘K's functions and classes): nothing is listed, read or
  /// analysed for it, so a query never waits for the build
  public func indexedEntries() -> [IndexEntry] { files.flatMap { byFile[$0] ?? [] } }

  /// Every file, in list order, with its entries
  public func indexedFiles() async -> [IndexedFile] {
    await list()
    return files.compactMap { abs in
      todo.contains(abs) ? IndexedFile(abs: abs) : byFile[abs].map { IndexedFile(abs: abs, entries: $0) }
    }
  }

  /// A file's entries, analysing it first when it is not yet
  public func entriesOf(_ abs: String) async -> [IndexEntry] {
    if todo.contains(abs) || byFile[abs] == nil { await indexFile(abs) }
    return byFile[abs] ?? []
  }

  /// A file was saved, created or changed outside the editor (or is a rename's new path): it is analysed again. Before
  /// the list is made nothing is to do, the list will have it
  public func changed(_ abs: String) {
    guard isCode(abs), listing != nil else { return }
    drop(abs)
    sigs[abs] = nil
    stamps[abs, default: 0] += 1
    place(abs)
    todo.insert(abs)
    if wanted { _ = drainTask() }
  }

  /// A file or folder was deleted (or is a rename's old path)
  public func removed(_ path: String) {
    let gone = Set(files.filter { $0 == path || $0.utf8.starts(with: (path + "/").utf8) })
    guard !gone.isEmpty else { return }
    for abs in gone {
      drop(abs)
      todo.remove(abs)
      sigs[abs] = nil
      order[abs] = nil
      stamps[abs, default: 0] += 1
    }
    files.removeAll { gone.contains($0) }
  }

  /// The workspace's roots changed: built again from the start
  public func reset() {
    gen += 1
    listing?.cancel()
    running?.cancel()
    listing = nil
    running = nil
    order = [:]
    files = []
    seq = 0
    byFile = [:]
    byName = [:]
    names = nil
    todo = InsertionSet()
    sigs = [:]
    if wanted { start(after: .seconds(1)) }
  }

  /// Stops the background build: work in flight sees the new generation and ends
  public func dispose() {
    disposed = true
    timer?.cancel()
    timer = nil
    gen += 1
    wanted = false
    listing?.cancel()
    running?.cancel()
    running = nil
  }
}
