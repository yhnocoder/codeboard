import CodeBoardAnalysis
import Foundation

// packages/host/src/resolve.ts's peek: what a name hovered on a code card is defined as. The language server first
// (its hover for the signature and docs, dynamic dispatch if it answers in time); without one an imported module, an
// assignment or parameter in the same function, the name index, a class body's field. The lines come as text with
// their language: the popup highlights them as the card does.

/// A peek's next hop: self.x = config.max_num_batched_tokens → config.max_num_batched_tokens · config.py:9
public struct PeekFollow: Hashable, Sendable {
  public var label: String
  public var line: Int
  public var col: Int
  /// As the host shows it
  public var path: String
}

/// Dynamic dispatch at a peeked method: how many implementations, and its class
public struct PeekDispatch: Hashable, Sendable {
  public var n: Int
  public var base: String
  public var abstract: Bool
}

/// What a peek shows (protocol.ts's PeekDef, without the highlighted HTML)
public struct PeekDef: Hashable, Sendable {
  /// As the host shows it
  public var path: String
  /// The definition's or assignment's line
  public var line: Int
  /// The first line shown
  public var start: Int
  public var lang: String
  /// The lines shown, and each one's line number (not always contiguous)
  public var text: [String]
  public var rows: [Int]
  /// What Pin as Sidenote and Place on Board make
  public var segment: CodeSegment
  public var kind: PeekKind
  /// A small title above the lines: class Config
  public var head: String?
  /// "⋯ N more lines"
  public var more: Int?
  public var sig: String?
  /// Markdown
  public var doc: String?
  /// The package of library code
  public var lib: String?
  /// Instead of file:line (a module: torch/multiprocessing)
  public var title: String?
  public var follow: PeekFollow?
  public var dispatch: PeekDispatch?
}

/// A name hovered: the segment's line and the name's column; at: a place to ask instead (a Follow's next hop)
public struct PeekRequest: Hashable, Sendable {
  public var seg: CodeSegment
  public var line: Int
  public var col: Int
  public var word: String
  public var at: (path: String, line: Int, col: Int)?

  public init(seg: CodeSegment, line: Int, col: Int, word: String, at: (path: String, line: Int, col: Int)? = nil) {
    self.seg = seg
    self.line = line
    self.col = col
    self.word = word
    self.at = at
  }

  public static func == (a: Self, b: Self) -> Bool {
    a.seg == b.seg && a.line == b.line && a.col == b.col && a.word == b.word && a.at?.path == b.at?.path
      && a.at?.line == b.at?.line && a.at?.col == b.at?.col
  }

  public func hash(into h: inout Hasher) {
    h.combine(seg)
    h.combine(line)
    h.combine(col)
    h.combine(word)
  }
}

extension Resolver {
  /// What a hovered name is defined as; nil when nothing is found
  public func peek(_ m: PeekRequest) async -> PeekDef? {
    var use: Def?
    if let at = m.at {
      use = Def(abs: fromHostPath(at.path), line: at.line, col: at.col)
    } else if m.seg.src != .free, let wp = await sources.workingPlace(m.seg), wp.exact {
      use = Def(abs: wp.abs, line: wp.start + (m.line - m.seg.start), col: m.col)
    }
    let defs = await use.asyncFlatMap { await lsp.clickDefs($0.abs, line: $0.line, col: $0.col) } ?? []
    let last = unitSplit(m.word, ".").last ?? m.word
    if let d = defs.first {
      // the hover at the use (the server's type there is more exact), else at the definition
      var hov = await use.asyncFlatMap { await hoverAt($0.abs, line: $0.line, col: $0.col) }
      if hov == nil { hov = await hoverAt(d.abs, line: d.line, col: d.col) }
      // nor does a peek wait for Go to Implementation: missed this time, it is kept for the next
      var dispatch: Dispatch?
      if defs.count == 1,
        case .done(let r) = await within(Task { await self.dispatchOf(d, name: last) }, dispatchWait, clock: lsp.clock)
      {
        dispatch = r
      }
      var out = await peekAt(d, word: m.word, hov: hov)
      if let dispatch {
        out?.dispatch = PeekDispatch(n: dispatch.n, base: dispatch.baseClass, abstract: dispatch.abstract)
      }
      return out
    }
    if let mod = await importedModule(m) { return mod }
    if let local = await localPeek(m) { return local }
    let hits = await lookup.index.lookupName(last)
    if let e = hits.count == 1 ? hits.first : rankedFirst(hits, m) {
      return await peekAt(Def(abs: e.abs, line: e.defLine, col: 0), word: last)
    }
    guard let f = await lookup.classField(last) else { return nil }
    return await peekAt(f, word: last)
  }

  private struct Hit: RankCandidate {
    var e: IndexEntry
    var path: String
    var qual: String { e.qual }
  }

  private func rankedFirst(_ hits: [IndexEntry], _ m: PeekRequest) -> IndexEntry? {
    let parts = unitSplit(m.word, ".")
    let recv = parts.count > 1 ? parts.dropLast().joined(separator: ".") : nil
    return rankByReceiver(hits.map { Hit(e: $0, path: lookup.hostPath($0.abs)) }, recv: recv, path: m.seg.path)
      .ranked.first?.e
  }

  /// The definition's lines by what it is, the hover's signature and docs (else its docstring's), the segment Pin and
  /// Place make, the next hop
  func peekAt(_ d: Def, word: String, hov: Hover? = nil, module forced: Bool = false) async -> PeekDef? {
    guard let text = await lookup.readText(d.abs), let loc = try? await sources.locOfFile(d.abs) else { return nil }
    let lines = splitLines(text)
    let lang = lookup.langOf(d.abs)
    let a = lookup.analysis.analysisOf(lang, text)
    let module =
      forced || startsWith(hov?.sig ?? "", "(module)") || isModuleDef(lines, line: d.line, col: d.col, word: word)
    let plan = peekPlan(a, lines, line: d.line, word: word, module: module)
    let at = { (l: Int) in l >= 1 && l <= lines.count ? lines[l - 1] : "" }
    var seg: CodeSegment?
    if !module, let sym = a.symbols.first(where: { $0.defLine == d.line }) {
      seg = await cardSegment(Target(abs: d.abs, sym: sym))
    } else {
      seg = try? await sources.makeSegment(
        id: "", loc, lines: lines, start: plan.rows.first ?? 1, end: plan.rows.last ?? min(lines.count, 1),
        scope: symbolAt(a.symbols, line: d.line)?.qual, lang: lang)
    }
    guard let seg else { return nil }
    var out = PeekDef(
      path: lookup.hostPath(d.abs), line: d.line, start: plan.rows.first ?? d.line, lang: lang,
      text: plan.rows.map(at), rows: plan.rows, segment: seg, kind: plan.kind, head: plan.head, more: plan.more,
      sig: hov?.sig ?? plan.sig, doc: hov?.doc ?? plan.doc, lib: sources.libOf(d.abs),
      title: module ? modTitle(loc.src.isRepo ? lookup.hostPath(d.abs) : loc.path) : nil)
    if !module, let f = followOf(at(d.line), word) {
      let next = await lsp.defs(d.abs, line: d.line, col: f.col).first
      let place = next.map { " · \(NodePath.basename($0.abs)):\($0.line)" } ?? ""
      out.follow = PeekFollow(label: f.expr + place, line: d.line, col: f.col, path: lookup.hostPath(d.abs))
    }
    return out
  }

  /// No server: the name is an imported module (import torch.multiprocessing as mp). A module of the workspace is
  /// shown by its docstring, a library's by its signature alone
  private func importedModule(_ m: PeekRequest) async -> PeekDef? {
    let seg = m.seg
    guard seg.src != .free, !textContains(m.word, "."),
      let full = ((try? await sources.versionText(seg)) ?? nil), !full.isEmpty,
      let im = lookup.analysis.segAnalysis(seg.lang, full, start: 1, end: 0).imports.first(where: {
        $0.name == m.word && $0.from != true
      })
    else { return nil }
    let rel = unitSplit(im.module, ".")
    for root in lookup.ws.roots {
      let dir = ([root] + rel).joined(separator: "/")
      for c in [dir + "/__init__.py", dir + ".py"] where FileManager.default.fileExists(atPath: c) {
        return await peekAt(Def(abs: c, line: 1, col: 0), word: m.word, module: true)
      }
    }
    let lines = splitLines(full)
    let line = im.line >= 1 && im.line <= lines.count ? lines[im.line - 1] : ""
    return PeekDef(
      path: lookup.hostPath(sources.absOf(seg) ?? seg.path), line: im.line, start: im.line, lang: seg.lang, text: [],
      rows: [],
      segment: CodeSegment(
        id: "", src: seg.src, path: seg.path, lang: seg.lang, start: im.line, end: im.line, text: [line],
        version: seg.version),
      kind: .module, sig: "(module) \(m.word)", lib: rel.first, title: rel.joined(separator: "/"))
  }

  /// No server: an assignment or parameter up the function the line is in (localDef), by the segment's version
  private func localPeek(_ m: PeekRequest) async -> PeekDef? {
    let seg = m.seg
    guard let l = (try? await localDef(seg, line: m.line, word: m.word)) ?? nil,
      let full = (try? await sources.versionText(seg)) ?? nil, let start = l.rows.first, let end = l.rows.last
    else { return nil }
    let lines = splitLines(full)
    let at = { (i: Int) in i >= 1 && i <= lines.count ? lines[i - 1] : "" }
    let abs = sources.absOf(seg)
    let fn = l.plan.kind == .function
    let field = l.plan.kind == .field
    var out = PeekDef(
      path: lookup.hostPath(abs ?? seg.path), line: l.line, start: start, lang: seg.lang, text: l.rows.map(at),
      rows: l.rows,
      segment: CodeSegment(
        id: "", src: seg.src, path: seg.path, lang: seg.lang, start: start, end: end,
        text: Array(lineSlice(lines, start - 1, end)), version: seg.version, scope: l.scope),
      kind: fn ? .other : l.plan.kind, head: fn ? nil : l.plan.head, more: fn ? nil : l.plan.more,
      sig: field ? l.plan.sig : nil, doc: field ? l.plan.doc : nil, lib: abs.flatMap(sources.libOf))
    if let f = l.follow {
      out.follow = PeekFollow(label: f.expr, line: l.line, col: f.col, path: lookup.hostPath(abs ?? seg.path))
    }
    return out
  }
}

extension SegmentSource {
  var isRepo: Bool {
    if case .repo = self { return true }
    return false
  }
}

extension Optional {
  func asyncFlatMap<U>(_ f: (Wrapped) async -> U?) async -> U? {
    guard let w = self else { return nil }
    return await f(w)
  }
}
